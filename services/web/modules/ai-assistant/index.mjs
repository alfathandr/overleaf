import {
  AiAssistantRouter,
  AiAssistantNonCsrfRouter,
} from './app/src/AiAssistantRouter.mjs'

/** @import { WebModule } from "../../types/web-module" */

/** @type {WebModule} */
const AiAssistantModule = {
  router: AiAssistantRouter,
  nonCsrfRouter: AiAssistantNonCsrfRouter,
}

export default AiAssistantModule
