import type { SmartAccountManifest } from "./types.js";
/** Source-pinned ownership binding only. EntryPoint/module execution proof is intentionally absent. */
export const CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS: readonly SmartAccountManifest[] =
  [
    {
      id: "safe-l2-1.4.1-safe7579-f22a194-sepolia-binding-only",
      chainId: 11155111,
      safeVersion: "1.4.1",
      proxyRuntimeCodeHash:
        "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
      singleton: {
        address: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
        runtimeCodeHash:
          "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
        source: {
          repository: "https://github.com/safe-global/safe-deployments",
          commit: "1c3aad8cf686157272d7e5de05dae8cf5594e0bc",
          artifactSha256:
            "6b022957b59c08d6477d7bc52a76f8c1c46ad7d4df4752e3c9410bf817cb8107",
        },
      },
      factory: {
        address: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
        runtimeCodeHash:
          "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
        source: {
          repository: "https://github.com/safe-global/safe-deployments",
          commit: "1c3aad8cf686157272d7e5de05dae8cf5594e0bc",
          artifactSha256:
            "b2756283f2501dbf02d73ae73529d8fcee8b20bbc7a3b57b5611c6242034c23f",
        },
      },
      safe7579: {
        address: "0x7579f2AD53b01c3D8779Fe17928e0D48885B0003",
        runtimeCodeHash:
          "0xc9c3866bdfbdb586211254dbe457aa3d1c9fd1acf1bbaa36e4c86c3ebc156b69",
        source: {
          repository: "https://github.com/rhinestonewtf/safe7579",
          commit: "f22a194148ff087f0c16125e530512e59794e188",
          artifactSha256:
            "5e40d3584872cd8bc0cea680f720a69c1cc49656e3f69e796deed718bb7cd37c",
        },
      },
      launchpad: {
        address: "0x75798463024Bda64D83c94A64Bc7D7eaB41300eF",
        runtimeCodeHash:
          "0x044b5e0086072ca4cb8e39c4d7fe5ae78def953b347eacd8d3abbba56946fb6e",
        source: {
          repository: "https://github.com/rhinestonewtf/safe7579",
          commit: "f22a194148ff087f0c16125e530512e59794e188",
          artifactSha256:
            "f897d0454ff6728a836b3e81b34afbc47900d6b40c5477d25d6c9ef5bc0ec186",
        },
      },
      smartSessions: {
        address: "0x00000000002B0eCfbD0496EE71e01257dA0E37DE",
        runtimeCodeHash:
          "0xf2817b8943b9fc813ad3602de2f0b973dc6b7e190f1b77dc9eb02b8d3022ab0c",
        source: {
          repository: "https://github.com/rhinestonewtf/smartsessions",
          commit: "f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188",
          artifactSha256:
            "0627bf4d72f954aa0168de4773e95571c782308cf0cb03935e4c19c417cff6ea",
        },
        generation: "legacy-validator",
      },
      policies: [
        {
          address: "0x0000000000D30f611fA3bf652ac6879428586930",
          runtimeCodeHash:
            "0xa8c18f7a974673552d03d7325bbc33a102a5aaab5bc5a3c11ecae1648ca4e026",
          source: {
            repository: "https://github.com/rhinestonewtf/smartsessions",
            commit: "75279a6c80ad50ea623d06954e9d71ab753e8a52",
            artifactSha256:
              "5d7d5afdef80e808ed1ebd9078a8f2512457245c8f49ad6641f8ecfae3d9ccc2",
          },
        },
        {
          address: "0x0000000000714Cf48FcF88A0bFBa70d313415032",
          runtimeCodeHash:
            "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
          source: {
            repository: "https://github.com/rhinestonewtf/smartsessions",
            commit: "75279a6c80ad50ea623d06954e9d71ab753e8a52",
            artifactSha256:
              "52599049835dedaf13699c350b8d5cba482635597ad2416f815fdf920f5f4466",
          },
        },
        {
          address: "0x000000000021dC45451291BCDfc9f0B46d6f0278",
          runtimeCodeHash:
            "0x086e8421c6c9daab4a93e63366c83e8f20cc3f736b7be5a97e0e81633581e4ed",
          source: {
            repository: "https://github.com/rhinestonewtf/smartsessions",
            commit: "75279a6c80ad50ea623d06954e9d71ab753e8a52",
            artifactSha256:
              "c3f7692e6921646b3bb6bb9d0424a43e2aaed5b25937a5b4f28df84d1ec52d90",
          },
        },
      ],
      moduleInspectorId: "safe7579-f22a194-unimplemented",
      mode: "ownership-only",
      revision:
        "0x2e99187339c8463b49b3a9c6b15ae2b9e2e62d0563bc520466b992190e790564",
    },
  ];
export const CHECKED_SAFE_PROXY_SOURCE = {
  repository: "https://github.com/rhinestonewtf/sdk",
  commit: "91f8f1edc80aa38e698033b5287b6aa7537bb641",
  path: "src/accounts/adapters/safe.ts",
  sourceSha256:
    "035dc073c95fd5cafb4c19094007cb430249dfb4706a343050b74d0e9235c344",
  runtimeCodeHash:
    "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  method:
    "Exact runtime returned by the fixed CODECOPY/RETURN segment of the source-pinned Safe proxy creation code; matches the existing Juicebox Money Safe runtime allowlist.",
} as const;
