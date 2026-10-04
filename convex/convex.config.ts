/**
 * Convex configuration for EVE
 */
import { defineApp } from "convex/server";
import { auth } from "./auth";

export default defineApp({ auth });
