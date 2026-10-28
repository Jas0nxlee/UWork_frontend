import { classifyDatabaseStartupError, databaseStartupErrorCodeSchema } from "./contract.js";
export const diskFullExample = databaseStartupErrorCodeSchema.parse(classifyDatabaseStartupError({ code: "ENOSPC" }));
