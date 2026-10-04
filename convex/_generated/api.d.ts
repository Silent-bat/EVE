/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as assistant from "../assistant.js";
import type * as auth from "../auth.js";
import type * as briefings from "../briefings.js";
import type * as clearUserArrays from "../clearUserArrays.js";
import type * as crons from "../crons.js";
import type * as debugSeed from "../debugSeed.js";
import type * as gmail from "../gmail.js";
import type * as http from "../http.js";
import type * as lib_aiGateway from "../lib/aiGateway.js";
import type * as lib_classify from "../lib/classify.js";
import type * as lib_gemini from "../lib/gemini.js";
import type * as lib_geminiFetch from "../lib/geminiFetch.js";
import type * as lib_gmailBody from "../lib/gmailBody.js";
import type * as lib_gmailSync from "../lib/gmailSync.js";
import type * as lib_google from "../lib/google.js";
import type * as lib_googleOAuth from "../lib/googleOAuth.js";
import type * as lib_googleScopes from "../lib/googleScopes.js";
import type * as lib_googleTokens from "../lib/googleTokens.js";
import type * as lib_openrouter from "../lib/openrouter.js";
import type * as lib_scoring from "../lib/scoring.js";
import type * as lib_secrets from "../lib/secrets.js";
import type * as migrations_removeUserArrays from "../migrations/removeUserArrays.js";
import type * as notifications from "../notifications.js";
import type * as proactive from "../proactive.js";
import type * as profile from "../profile.js";
import type * as tasks from "../tasks.js";
import type * as tempClearArrays from "../tempClearArrays.js";
import type * as tools from "../tools.js";
import type * as users from "../users.js";
import type * as voice from "../voice.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  assistant: typeof assistant;
  auth: typeof auth;
  briefings: typeof briefings;
  clearUserArrays: typeof clearUserArrays;
  crons: typeof crons;
  debugSeed: typeof debugSeed;
  gmail: typeof gmail;
  http: typeof http;
  "lib/aiGateway": typeof lib_aiGateway;
  "lib/classify": typeof lib_classify;
  "lib/gemini": typeof lib_gemini;
  "lib/geminiFetch": typeof lib_geminiFetch;
  "lib/gmailBody": typeof lib_gmailBody;
  "lib/gmailSync": typeof lib_gmailSync;
  "lib/google": typeof lib_google;
  "lib/googleOAuth": typeof lib_googleOAuth;
  "lib/googleScopes": typeof lib_googleScopes;
  "lib/googleTokens": typeof lib_googleTokens;
  "lib/openrouter": typeof lib_openrouter;
  "lib/scoring": typeof lib_scoring;
  "lib/secrets": typeof lib_secrets;
  "migrations/removeUserArrays": typeof migrations_removeUserArrays;
  notifications: typeof notifications;
  proactive: typeof proactive;
  profile: typeof profile;
  tasks: typeof tasks;
  tempClearArrays: typeof tempClearArrays;
  tools: typeof tools;
  users: typeof users;
  voice: typeof voice;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
