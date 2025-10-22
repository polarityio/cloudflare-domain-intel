const { PolarityRequest } = require('polarity-integration-utils/requests');
const { setLogger, getLogger } = require('polarity-integration-utils/logging');
const { ApiRequestError, NetworkError } = require('polarity-integration-utils/errors');
const z = require('zod');

let request;

const domainResultSchema = z.object({
  result: z.array(
    z.object({
      domain: z.string().toLowerCase(),
      domain_id: z.number().optional(),
      inherited_from: z.string().optional(),
      application: z
        .union([
          z.object({}).strict(),
          z.object({
            id: z.number(),
            name: z.string()
          })
        ])
        .optional()
        .transform((val) => (val && Object.keys(val).length === 0 ? undefined : val)),
      risk_type: z
        .array(
          z.object({
            id: z.number(),
            super_category_id: z.number().optional(),
            name: z.string()
          })
        )
        .optional(),
      inherited_content_categories: z
        .array(
          z.object({
            id: z.number(),
            super_category_id: z.number().optional(),
            name: z.string()
          })
        )
        .optional(),
      content_categories: z
        .array(
          z.object({
            id: z.number(),
            super_category_id: z.number().optional(),
            name: z.string()
          })
        )
        .optional(),
      resolution_history: z
        .array(
          z.object({
            FirstObserved: z.string(),
            LastObserved: z.string(),
            Query: z.string(),
            IP: z.string()
          })
        )
        .optional()
        .nullable()
    })
  ),
  success: z.boolean(),
  errors: z.array(z.any()).optional(),
  messages: z.array(z.any()).optional()
});

function startup(logger) {
  setLogger(logger);
  request = new PolarityRequest();
}

/**
 * Groups entities into bags of `groupingSize` entities so we can do a bulk lookup of
 * `groupingSize` entities at a time.
 * @param entities
 * @return An array of arrays
 */
function groupEntities(entities, groupingSize = 2) {
  const groupedEntities = [];
  for (let i = 0; i < entities.length; i += groupingSize) {
    groupedEntities.push(entities.slice(i, i + groupingSize));
  }
  return groupedEntities;
}

async function doLookup(entities, options, cb) {
  const Logger = getLogger();
  Logger.info({ entities }, 'doLookup');
  
  request.userOptions = options;

  // Group entities in bags of 5 for bulk lookup
  const groupedEntities = groupEntities(entities);

  // Create a lookup map to find an entity object by the entity value
  const entitiesLookup = new Map(entities.map((entity) => [entity.value.toLowerCase(), entity]));

  const requests = groupedEntities.map((entityGroup) => {
    const domains = entityGroup.map((entity) => entity.value);
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/intel/domain/bulk`,
      headers: {
        Authorization: `Bearer ${options.apiToken}`
      },
      qs: {
        domain: domains
      },
      useQuerystring: true
    };
  });

  Logger.debug({ requests }, 'Bulk Domain Lookup Requests');

  try {
    const lookupResults = [];

    const responses = await request.runInParallel({
      allRequestOptions: requests,
      // Each request is a bulk lookup of 2 domains so we don't run more than 2 at a time
      maxConcurrentRequests: 3
    });

    responses.forEach((response) => {
      Logger.trace({ response }, 'Bulk Domain Lookup Response');

      const parsedResult = domainResultSchema.parse(response.body);

      Logger.trace({ parsedResult }, 'Bulk Domain Parsed Result');

      parsedResult.result.forEach((result) => {
        const entity = entitiesLookup.get(result.domain);
        if (entity) {
          if (isMiss(result)) {
            lookupResults.push({
              entity,
              data: null
            });
          } else {
            lookupResults.push({
              entity,
              data: {
                summary: getSummaryTags(result),
                details: {
                  result,
                  rateLimit: getRateLimit(response.headers)
                }
              }
            });
          }
        } else {
          Logger.warn({ cloudflareDomainValue: result.domain }, 'Could not map domain value to entity lookup');
        }
      });
    });

    Logger.debug({ numLookupResults: lookupResults.length }, 'doLookup results');

    cb(null, lookupResults);
  } catch (error) {
    Logger.error(error, 'Error running domain intel search');
    if (error instanceof ApiRequestError) {
      // handle API request error
      cb(error);
    } else if (error instanceof NetworkError) {
      // handle network errors
      cb(error);
    } else if (error instanceof z.ZodError) {
      // Unexpected data format returned
      cb({
        detail: 'Unexpected response format received',
        issues: error.issues
      });
    } else {
      // handle other errors
      cb(error);
    }
  }
}

function trimTags(tags, limit = 4, postfixString = 'more') {
  if (!Array.isArray(tags)) return [];
  if (tags.length <= limit) return tags;
  const trimmed = tags.slice(0, limit);
  trimmed.push(`+${tags.length - limit} ${postfixString}`);
  return trimmed;
}

function getSummaryTags(result) {
  if (Array.isArray(result.risk_type) && result.risk_type.length > 0) {
    return trimTags(
      result.risk_type.map((risk) => risk.name),
      2,
      'risks'
    );
  }

  if (Array.isArray(result.content_categories) && result.content_categories.length > 0) {
    return trimTags(
      result.content_categories.map((category) => category.name),
      2,
      'categories'
    );
  }

  if (Array.isArray(result.inherited_content_categories) && result.inherited_content_categories.length > 0) {
    return trimTags(
      result.inherited_content_categories.map((category) => category.name),
      2,
      'categories'
    );
  }

  if (Array.isArray(result.resolution_history) && result.resolution_history.length > 0) {
    return [`Resolutions: ${result.resolution_history.length}`];
  }

  // Should never get here
  return ['Result Available'];
}

/**
 * Cloudflare API provides the ratelimit as a combination of two headers with the following format
 * ```
 * RateLimit: "policyName";requestsRemainingInWindow;timeLeftInWindowInSeconds
 * RateLimit-Policy: "policyName";quota;window
 * ```
 * The following is an example with actual values:
 * ```
 * RateLimit: "default";r=1199;t=1
 * RateLimit-Policy: "default";q=1200;w=300
 * ```
 * This method parses the headers and return an object containing the rate limit information which
 * can be displayed to the user.
 * @param headers
 * @returns {{quota, window, timeLeftInWindowInSeconds, requestsRemainingInWindow}}
 */
function getRateLimit(headers) {
  let quota;
  let window;
  let timeLeftInWindowInSeconds;
  let requestsRemainingInWindow;

  if (headers['RateLimit-Policy']) {
    const tokens = headers['RateLimit-Policy'].split(';');
    if (tokens.length === 3) {
      quota = tokens[1];
      window = tokens[2];
    }
  }

  if (headers['RateLimit']) {
    const tokens = headers['RateLimit'].split(';');
    if (tokens.length === 3) {
      requestsRemainingInWindow = tokens[1];
      timeLeftInWindowInSeconds = tokens[2];
    }
  }

  return {
    quota,
    window,
    timeLeftInWindowInSeconds,
    requestsRemainingInWindow
  };
}

/**
 * Returns true if the lookup is a miss (i.e., no relevant data)
 * @param result
 * @returns {boolean}
 */
function isMiss(result) {
  // At least one of these properties needs to be present for us to consider the result a hit
  // The Cloudflare Bulk API appears to always return a result for a looked up domain no matter
  // what the domain format is.
  return (
    !result.risk_type &&
    !result.content_categories &&
    !result.resolution_history &&
    !result.inherited_content_categories
  );
}

module.exports = {
  startup,
  doLookup
};
