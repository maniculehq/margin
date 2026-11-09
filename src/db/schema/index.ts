import {
    docsAsset,
    docsBlobNamespace,
    docsContentVersion,
    docsMeta,
    docsOpenapiDocument,
    docsPage,
    docsSkill,
} from "./content"
import { docsAgentFeedback } from "./feedback"
import { publicRateLimit } from "./rate-limit"
import { docsSite } from "./site"

export * from "./content"
export * from "./enums"
export * from "./feedback"
export * from "./rate-limit"
export * from "./site"

export const schema = {
    docsSite,
    docsContentVersion,
    docsPage,
    docsOpenapiDocument,
    docsAsset,
    docsBlobNamespace,
    docsMeta,
    docsSkill,
    docsAgentFeedback,
    publicRateLimit,
}
