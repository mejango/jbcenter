/** Independently reviewed packages; never replace the original stack manifest identity. */
export const CURRENT_PIMLICO_PAYMASTER_MANIFEST_SHA256 = "d199bb80d60381f98fdcb91a6609c2b3aa52035e0433534341a574a86487ab14";
export const CURRENT_PIMLICO_GUARD_MANIFEST_SHA256 = "3b060e0ec08fc2e154ef6cb01617328d6a1ea3e44273e043dae8d2d74bba9114";
export const CURRENT_PIMLICO_GUARD_RUNTIME_HASH = "0xb8787af1b7dad3b5fac11ec656824adbe575610ee467661be4acde928e3d7c04" as const;
export const CURRENT_PIMLICO_PAYMASTER = Object.freeze({
  address: "0x777777777777aec03fd955926dbf81597e66834c" as const,
  runtimeCodeHash: "0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc" as const,
});
export type SmartAccountPaymasterProfile = "pimlico-v7-legacy-mode" | "pimlico-v7-current-flags";
export type SessionGuardVersion = "legacy-v1" | "current-v2";
