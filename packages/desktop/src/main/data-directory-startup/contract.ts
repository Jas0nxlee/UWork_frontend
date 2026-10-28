import { z } from "zod";
import { databaseStartupErrorCodeSchema, databaseStartupErrorDetailsSchema } from "@zcode/shared";

export const dataDirectoryWorkerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      phase: z.enum(["checking", "waiting_for_lock", "migrating", "committing"]),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
  z
    .object({
      type: z.literal("failed"),
      errorCode: databaseStartupErrorCodeSchema,
      canCancel: z.boolean().optional(),
      ...databaseStartupErrorDetailsSchema.shape,
    })
    .strict(),
]);
export type DataDirectoryPreparationPhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "committing";

/** 完成后才允许业务 Main/Host 导入；失败只沿现有 startup gate 显式重试。 */
export interface DataDirectoryStartupContract {
  cancel(signal: AbortSignal): Promise<void>;
  prepare(
    report: (phase: DataDirectoryPreparationPhase) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
