// Pass criteria for the CFAST comparison (fire-zone Req 13.4, 13.5). These are the only numbers in this file.
// Never loosen them to make a case pass. A change needs a written reason in the spec first (Req 13.7).

/** Times below this are excluded from every comparison, s (Req 13.4). */
export const COMPARE_START_TIME_S = 60;

/** Layer temperature Rise: within 5 % of the CFAST Rise, or 2 K, whichever is larger (Req 13.5). */
export const RISE_REL_TOL = 0.05;
export const RISE_ABS_TOL_K = 2;

/** Interface height: within 0.10 m of the CFAST value (Req 13.5). */
export const INTERFACE_HEIGHT_ABS_TOL_M = 0.1;

/** Vent layer mass flow: within 10 % of the CFAST value, or 0.005 kg/s, whichever is larger (Req 13.5). */
export const VENT_FLOW_REL_TOL = 0.1;
export const VENT_FLOW_ABS_TOL_KG_S = 0.005;
