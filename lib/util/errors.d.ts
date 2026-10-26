/** Tool-layer error codes (independent of the seam's WorkflowErrorCode). */
import { HarnessError } from '@deepseek-ai/dsh-llm';
export declare const DW_ERROR_CODES: {
    readonly AMEND_UNAVAILABLE: 21;
    readonly MISSING_BOUNDARIES: 22;
    readonly SUBAGENT_MODEL: 23;
    readonly SCRIPT_UNCHANGED: 24;
    readonly SCRIPT_FILE: 25;
    readonly SCRIPT_UNAVAILABLE: 26;
    readonly RETUNE_UNCHANGED: 27;
    readonly RUN_SETTLED: 28;
    readonly NOT_RETUNABLE: 29;
    readonly SAVED_UNAVAILABLE: 30;
    readonly HOLE_UNAVAILABLE: 31;
};
export type DwfErrorCode = (typeof DW_ERROR_CODES)[keyof typeof DW_ERROR_CODES];
export declare class DwfError extends HarnessError {
    constructor(message: string, code: DwfErrorCode);
}
export declare function amendUnavailable(tool: string): DwfError;
export declare function savedUnavailable(tool: string): DwfError;
export declare function holeUnavailable(holeId: string): DwfError;
