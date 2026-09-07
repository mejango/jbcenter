/** Read-only research observations; these do not activate a runtime deployment manifest. */
export const SMART_ACCOUNT_RESEARCH = {
  schemaVersion: 1,
  readOnly: true,
  observedAt: "2026-09-07T05:15:49.658Z",
  limitations: [
    "Public RPC observations are not deployment receipts, independent-node consensus, an audit, or verified account configuration.",
    "Code presence does not establish usable session expiry. Emissary expiry compatibility is under review.",
    "Source and artifact metadata must be bound separately; package version labels are not code identities.",
  ],
  contracts: {
    safeSingletonFactory: {
      address: "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7",
      bytes: 69,
      keccak256:
        "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989",
    },
    safeSingleton: {
      address: "0x29fcb43b46531bca003ddc8fcb67ffe91900c762",
      bytes: 24421,
      keccak256:
        "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
      contractName: "SafeL2",
      version: "1.4.1",
      source: {
        repository: "https://github.com/safe-global/safe-deployments",
        commit: "1c3aad8cf686157272d7e5de05dae8cf5594e0bc",
        artifactSha256:
          "6b022957b59c08d6477d7bc52a76f8c1c46ad7d4df4752e3c9410bf817cb8107",
      },
      artifact:
        "https://github.com/safe-global/safe-deployments/blob/1c3aad8cf686157272d7e5de05dae8cf5594e0bc/src/assets/v1.4.1/safe_l2.json",
      artifactType: "officialDeploymentManifestWithAbiAndCodeHash",
      officialManifestCodeHashMatchesObservedRuntime: true,
      officialManifestExplicitlyListsAllRequestedChains: true,
      localArtifactPath: "/private/tmp/center-smart-SafeL2-artifact.json",
    },
    safeProxyFactory: {
      address: "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67",
      bytes: 3054,
      keccak256:
        "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
      contractName: "SafeProxyFactory",
      version: "1.4.1",
      source: {
        repository: "https://github.com/safe-global/safe-deployments",
        commit: "1c3aad8cf686157272d7e5de05dae8cf5594e0bc",
        artifactSha256:
          "b2756283f2501dbf02d73ae73529d8fcee8b20bbc7a3b57b5611c6242034c23f",
      },
      artifact:
        "https://github.com/safe-global/safe-deployments/blob/1c3aad8cf686157272d7e5de05dae8cf5594e0bc/src/assets/v1.4.1/safe_proxy_factory.json",
      artifactType: "officialDeploymentManifestWithAbiAndCodeHash",
      officialManifestCodeHashMatchesObservedRuntime: true,
      officialManifestExplicitlyListsAllRequestedChains: true,
      localArtifactPath:
        "/private/tmp/center-smart-SafeProxyFactory-artifact.json",
    },
    adapterV1: {
      address: "0x7579f2AD53b01c3D8779Fe17928e0D48885B0003",
      bytes: 23929,
      keccak256:
        "0xc9c3866bdfbdb586211254dbe457aa3d1c9fd1acf1bbaa36e4c86c3ebc156b69",
      artifact:
        "https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579/Safe7579.json",
      artifactSha256:
        "5e40d3584872cd8bc0cea680f720a69c1cc49656e3f69e796deed718bb7cd37c",
      immutableReferences: {
        "7146": [
          {
            start: 5535,
            length: 32,
          },
          {
            start: 6055,
            length: 32,
          },
          {
            start: 6446,
            length: 32,
          },
          {
            start: 8315,
            length: 32,
          },
          {
            start: 10226,
            length: 32,
          },
          {
            start: 16832,
            length: 32,
          },
          {
            start: 17040,
            length: 32,
          },
          {
            start: 18409,
            length: 32,
          },
          {
            start: 18714,
            length: 32,
          },
        ],
      },
      immutableValues: {
        "7146": [
          "0x0000000000000000000000003fb7a8bee59d8c5b2f1cf6ce93e5e694cb233b57",
        ],
      },
      compiler: {
        version: "0.8.30+commit.73712a01",
      },
      compilationTarget: {
        "src/Safe7579.sol": "Safe7579",
      },
      normalizedRuntimeKeccak256:
        "0xc13aace33937bd17e9f13cd4dbf11d2e143c774a2f53bc7f3cfc22706b87034f",
      matchType: "exactAfterZeroingDeclaredImmutableLocations",
      source: {
        repository: "https://github.com/rhinestonewtf/safe7579",
        commit: "f22a194148ff087f0c16125e530512e59794e188",
        artifactSha256:
          "5e40d3584872cd8bc0cea680f720a69c1cc49656e3f69e796deed718bb7cd37c",
      },
      localArtifactPath: "/private/tmp/center-smart-Safe7579-artifact.json",
      bindingObservedDirectlyOnChains: [1, 11155111],
      sameObservedRawRuntimeHashOnAllRequestedChains: true,
    },
    launchpadV1: {
      address: "0x75798463024Bda64D83c94A64Bc7D7eaB41300eF",
      bytes: 11726,
      keccak256:
        "0x044b5e0086072ca4cb8e39c4d7fe5ae78def953b347eacd8d3abbba56946fb6e",
      artifact:
        "https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579Launchpad/Safe7579Launchpad.json",
      artifactSha256:
        "f897d0454ff6728a836b3e81b34afbc47900d6b40c5477d25d6c9ef5bc0ec186",
      immutableReferences: {
        "3284": [
          {
            start: 240,
            length: 32,
          },
          {
            start: 1066,
            length: 32,
          },
          {
            start: 2840,
            length: 32,
          },
          {
            start: 4429,
            length: 32,
          },
        ],
        "3286": [
          {
            start: 442,
            length: 32,
          },
          {
            start: 1176,
            length: 32,
          },
          {
            start: 4276,
            length: 32,
          },
          {
            start: 5600,
            length: 32,
          },
        ],
        "3289": [
          {
            start: 362,
            length: 32,
          },
          {
            start: 2616,
            length: 32,
          },
        ],
      },
      immutableValues: {
        "3284": [
          "0x00000000000000000000000075798463024bda64d83c94a64bc7d7eab41300ef",
        ],
        "3286": [
          "0x0000000000000000000000000000000071727de22e5e9d8baf0edac6f37da032",
        ],
        "3289": [
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        ],
      },
      compiler: {
        version: "0.8.30+commit.73712a01",
      },
      compilationTarget: {
        "src/Safe7579Launchpad.sol": "Safe7579Launchpad",
      },
      normalizedRuntimeKeccak256:
        "0x1d64c403ee087140ea16ad4de4e4ed039f9baac2abcc1071c039d3e2f8a6e43f",
      matchType: "exactAfterZeroingDeclaredImmutableLocations",
      source: {
        repository: "https://github.com/rhinestonewtf/safe7579",
        commit: "f22a194148ff087f0c16125e530512e59794e188",
        artifactSha256:
          "f897d0454ff6728a836b3e81b34afbc47900d6b40c5477d25d6c9ef5bc0ec186",
      },
      localArtifactPath:
        "/private/tmp/center-smart-Safe7579Launchpad-artifact.json",
      bindingObservedDirectlyOnChains: [1, 11155111],
      sameObservedRawRuntimeHashOnAllRequestedChains: true,
    },
    smartSessionLegacy: {
      address: "0x00000000002B0eCfbD0496EE71e01257dA0E37DE",
      bytes: 23940,
      keccak256:
        "0xf2817b8943b9fc813ad3602de2f0b973dc6b7e190f1b77dc9eb02b8d3022ab0c",
      artifact:
        "https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/SmartSession/SmartSession.json",
      artifactSha256:
        "0627bf4d72f954aa0168de4773e95571c782308cf0cb03935e4c19c417cff6ea",
      artifactRuntimeExactMatch: true,
      source: {
        repository: "https://github.com/rhinestonewtf/smartsessions",
        commit: "f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188",
        artifactSha256:
          "0627bf4d72f954aa0168de4773e95571c782308cf0cb03935e4c19c417cff6ea",
      },
    },
    ownableV1: {
      address: "0x000000000013fdB5234E4E3162a810F54d9f7E98",
      bytes: 12702,
      keccak256:
        "0x4194d92c6d0b18f35a865f2796c3a0b85b9af299c8110214dfae3f69bee60d11",
    },
    ownableLegacy: {
      address: "0x2483DA3A338895199E5e538530213157e931Bf06",
      bytes: 6633,
      keccak256:
        "0xd9ad90a204447aec1a1528d764e1d80212c8011dc0125b3995875e58ec9a43bf",
    },
    compatibilityV1: {
      address: "0x000000000052e9685932845660777DF43C2dC496",
      bytes: 2439,
      keccak256:
        "0xe691f0762f697e79e67d79b3ea3970abc3eaf041b37ba2bd60f67eaac2a3780a",
    },
    uniActionV1: {
      address: "0x0000000000714Cf48FcF88A0bFBa70d313415032",
      bytes: 3084,
      keccak256:
        "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
      artifact:
        "https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/UniActionPolicy/UniActionPolicy.json",
      artifactSha256:
        "52599049835dedaf13699c350b8d5cba482635597ad2416f815fdf920f5f4466",
      artifactRuntimeExactMatch: true,
      source: {
        repository: "https://github.com/rhinestonewtf/smartsessions",
        commit: "75279a6c80ad50ea623d06954e9d71ab753e8a52",
        artifactSha256:
          "52599049835dedaf13699c350b8d5cba482635597ad2416f815fdf920f5f4466",
      },
    },
    valueLimitV1: {
      address: "0x000000000021dC45451291BCDfc9f0B46d6f0278",
      bytes: 2511,
      keccak256:
        "0x086e8421c6c9daab4a93e63366c83e8f20cc3f736b7be5a97e0e81633581e4ed",
      artifact:
        "https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/ValueLimitPolicy/ValueLimitPolicy.json",
      artifactSha256:
        "c3f7692e6921646b3bb6bb9d0424a43e2aaed5b25937a5b4f28df84d1ec52d90",
      artifactRuntimeExactMatch: true,
      source: {
        repository: "https://github.com/rhinestonewtf/smartsessions",
        commit: "75279a6c80ad50ea623d06954e9d71ab753e8a52",
        artifactSha256:
          "c3f7692e6921646b3bb6bb9d0424a43e2aaed5b25937a5b4f28df84d1ec52d90",
      },
    },
    timeFrameV1: {
      address: "0x0000000000D30f611fA3bf652ac6879428586930",
      bytes: 1911,
      keccak256:
        "0xa8c18f7a974673552d03d7325bbc33a102a5aaab5bc5a3c11ecae1648ca4e026",
      artifact:
        "https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/TimeFramePolicy/TimeFramePolicy.json",
      artifactSha256:
        "5d7d5afdef80e808ed1ebd9078a8f2512457245c8f49ad6641f8ecfae3d9ccc2",
      artifactRuntimeExactMatch: true,
      source: {
        repository: "https://github.com/rhinestonewtf/smartsessions",
        commit: "75279a6c80ad50ea623d06954e9d71ab753e8a52",
        artifactSha256:
          "5d7d5afdef80e808ed1ebd9078a8f2512457245c8f49ad6641f8ecfae3d9ccc2",
      },
    },
    entryPoint07: {
      address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      bytes: 16035,
      keccak256:
        "0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58",
    },
    emissary: {
      address: "0xad568b3f825a8d5ffc06dd3253526b64d810ae89",
      bytes: 23507,
      keccak256PerChain: {
        "1": "0xa253eeb5e0a3ebec6f7b4097ecb45ab07fe5bd719ffaacce40a8ff4556d9d677",
        "10": "0x72465a1362faf09832c5af86e8184012972aafa14b675634e3656eae49601655",
        "8453":
          "0xf527e070666d2a36f497083bb072233d3816bd36e2742f48206628a95abcafaf",
        "42161":
          "0xc4458f69a0276432a1503a332b5e95f3d022d10781ad2ede5849488094efa33f",
        "84532":
          "0xe0e58c4c454f73e354b1188edaeedb53b00b1615fc1583703ed6a469f259d988",
        "421614":
          "0xaa4ed00c08210491855209a422b5554ddef22a7281214f226917cc398059adce",
        "11155111":
          "0xaa8252d18e8c0868ef1cfba599d28f382ce17ce8850a83066562b06675193bdf",
        "11155420":
          "0x0205d1244a7ba8b787a3dd83141e9c9fa761acec09b1e54a355dfb055bf2490a",
      },
    },
    adapterLegacy: {
      address: "0x7579EE8307284F293B1927136486880611F20002",
      perChain: {
        "1": {
          address: "0x7579EE8307284F293B1927136486880611F20002",
          bytes: 20014,
          keccak256:
            "0xe03f1efc4aa74c91a87731397278a9c32d81f593263931fc94ff867aa09b83ac",
          artifactBindings: [],
        },
        "11155111": {
          address: "0x7579EE8307284F293B1927136486880611F20002",
          bytes: 20014,
          keccak256:
            "0xe03f1efc4aa74c91a87731397278a9c32d81f593263931fc94ff867aa09b83ac",
          artifactBindings: [],
        },
      },
      observedOnlyOnChains: [1, 11155111],
    },
    launchpadLegacy: {
      address: "0x7579011aB74c46090561ea277Ba79D510c6C00ff",
      perChain: {
        "1": {
          address: "0x7579011aB74c46090561ea277Ba79D510c6C00ff",
          bytes: 11335,
          keccak256:
            "0xe15c7413325ecf9e9fe60a315a0c9b49ad3003f3e6c254b9fa841dff8a8a32a5",
          artifactBindings: [],
        },
        "11155111": {
          address: "0x7579011aB74c46090561ea277Ba79D510c6C00ff",
          bytes: 11335,
          keccak256:
            "0xe15c7413325ecf9e9fe60a315a0c9b49ad3003f3e6c254b9fa841dff8a8a32a5",
          artifactBindings: [],
        },
      },
      observedOnlyOnChains: [1, 11155111],
    },
    uniActionLegacy: {
      address: "0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F",
      perChain: {
        "1": {
          address: "0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F",
          bytes: 3084,
          keccak256:
            "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
          artifactBindings: [
            {
              artifact:
                "https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/UniActionPolicy/UniActionPolicy.json",
              artifactSha256:
                "b385f7a360b31f1a0e4ab36794bbebd71574317527a411478b3b6f498cfadd22",
              immutableReferences: {},
              immutableValues: {},
              compiler: {
                version: "0.8.28+commit.7893614a",
              },
              compilationTarget: {
                "contracts/external/policies/UniActionPolicy.sol":
                  "UniActionPolicy",
              },
              normalizedRuntimeKeccak256:
                "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
              matchType: "exactRuntime",
            },
          ],
        },
        "11155111": {
          address: "0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F",
          bytes: 3084,
          keccak256:
            "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
          artifactBindings: [
            {
              artifact:
                "https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/UniActionPolicy/UniActionPolicy.json",
              artifactSha256:
                "b385f7a360b31f1a0e4ab36794bbebd71574317527a411478b3b6f498cfadd22",
              immutableReferences: {},
              immutableValues: {},
              compiler: {
                version: "0.8.28+commit.7893614a",
              },
              compilationTarget: {
                "contracts/external/policies/UniActionPolicy.sol":
                  "UniActionPolicy",
              },
              normalizedRuntimeKeccak256:
                "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
              matchType: "exactRuntime",
            },
          ],
        },
      },
      observedOnlyOnChains: [1, 11155111],
    },
    timeFrameLegacy: {
      address: "0x8177451511dE0577b911C254E9551D981C26dc72",
      perChain: {
        "1": {
          address: "0x8177451511dE0577b911C254E9551D981C26dc72",
          bytes: 0,
          keccak256:
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
          artifactBindings: [],
        },
        "11155111": {
          address: "0x8177451511dE0577b911C254E9551D981C26dc72",
          bytes: 2539,
          keccak256:
            "0xfe83529b2df328020b49b8e728f62e571e21a38b3b7e59e75d6c6629a38cd87c",
          artifactBindings: [],
        },
      },
      observedOnlyOnChains: [1, 11155111],
    },
    valueLimitLegacy: {
      address: "0x730DA93267E7E513e932301B47F2ac7D062abC83",
      perChain: {
        "1": {
          address: "0x730DA93267E7E513e932301B47F2ac7D062abC83",
          bytes: 0,
          keccak256:
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
          artifactBindings: [],
        },
        "11155111": {
          address: "0x730DA93267E7E513e932301B47F2ac7D062abC83",
          bytes: 3192,
          keccak256:
            "0xc5efddfaf9a5fad8cb996f1fd03056926af11ebd4496a7a7758e2e4315a7865e",
          artifactBindings: [],
        },
      },
      observedOnlyOnChains: [1, 11155111],
    },
  },
  chains: [
    {
      chainId: 1,
      publicRpcUrl: "https://ethereum-rpc.publicnode.com",
      blockNumber: 25923286,
      blockHash:
        "0xab3664a40a7ee6dbda65f7a447cfeb0de961ca6f9cb15b9dc45772fce6f9da07",
      chainIdVerified: true,
      blockHashRechecked: true,
      additionalCode: {
        adapterLegacy: {
          address: "0x7579EE8307284F293B1927136486880611F20002",
          bytes: 20014,
          keccak256:
            "0xe03f1efc4aa74c91a87731397278a9c32d81f593263931fc94ff867aa09b83ac",
          artifactBindings: [],
        },
        launchpadLegacy: {
          address: "0x7579011aB74c46090561ea277Ba79D510c6C00ff",
          bytes: 11335,
          keccak256:
            "0xe15c7413325ecf9e9fe60a315a0c9b49ad3003f3e6c254b9fa841dff8a8a32a5",
          artifactBindings: [],
        },
        uniActionLegacy: {
          address: "0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F",
          bytes: 3084,
          keccak256:
            "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
          artifactBindings: [
            {
              artifact:
                "https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/UniActionPolicy/UniActionPolicy.json",
              artifactSha256:
                "b385f7a360b31f1a0e4ab36794bbebd71574317527a411478b3b6f498cfadd22",
              immutableReferences: {},
              immutableValues: {},
              compiler: {
                version: "0.8.28+commit.7893614a",
              },
              compilationTarget: {
                "contracts/external/policies/UniActionPolicy.sol":
                  "UniActionPolicy",
              },
              normalizedRuntimeKeccak256:
                "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
              matchType: "exactRuntime",
            },
          ],
        },
        valueLimitLegacy: {
          address: "0x730DA93267E7E513e932301B47F2ac7D062abC83",
          bytes: 0,
          keccak256:
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
          artifactBindings: [],
        },
        timeFrameLegacy: {
          address: "0x8177451511dE0577b911C254E9551D981C26dc72",
          bytes: 0,
          keccak256:
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
          artifactBindings: [],
        },
        emissary: {
          address: "0xad568b3f825a8d5ffc06dd3253526b64d810ae89",
          bytes: 23507,
          keccak256:
            "0xa253eeb5e0a3ebec6f7b4097ecb45ab07fe5bd719ffaacce40a8ff4556d9d677",
          artifactBindings: [],
        },
        adapterV1: {
          address: "0x7579f2AD53b01c3D8779Fe17928e0D48885B0003",
          bytes: 23929,
          keccak256:
            "0xc9c3866bdfbdb586211254dbe457aa3d1c9fd1acf1bbaa36e4c86c3ebc156b69",
          artifactBindings: [
            {
              artifact:
                "https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579/Safe7579.json",
              artifactSha256:
                "5e40d3584872cd8bc0cea680f720a69c1cc49656e3f69e796deed718bb7cd37c",
              immutableReferences: {
                "7146": [
                  {
                    start: 5535,
                    length: 32,
                  },
                  {
                    start: 6055,
                    length: 32,
                  },
                  {
                    start: 6446,
                    length: 32,
                  },
                  {
                    start: 8315,
                    length: 32,
                  },
                  {
                    start: 10226,
                    length: 32,
                  },
                  {
                    start: 16832,
                    length: 32,
                  },
                  {
                    start: 17040,
                    length: 32,
                  },
                  {
                    start: 18409,
                    length: 32,
                  },
                  {
                    start: 18714,
                    length: 32,
                  },
                ],
              },
              immutableValues: {
                "7146": [
                  "0x0000000000000000000000003fb7a8bee59d8c5b2f1cf6ce93e5e694cb233b57",
                ],
              },
              compiler: {
                version: "0.8.30+commit.73712a01",
              },
              compilationTarget: {
                "src/Safe7579.sol": "Safe7579",
              },
              normalizedRuntimeKeccak256:
                "0xc13aace33937bd17e9f13cd4dbf11d2e143c774a2f53bc7f3cfc22706b87034f",
              matchType: "exactAfterZeroingDeclaredImmutableLocations",
            },
          ],
        },
        launchpadV1: {
          address: "0x75798463024Bda64D83c94A64Bc7D7eaB41300eF",
          bytes: 11726,
          keccak256:
            "0x044b5e0086072ca4cb8e39c4d7fe5ae78def953b347eacd8d3abbba56946fb6e",
          artifactBindings: [
            {
              artifact:
                "https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579Launchpad/Safe7579Launchpad.json",
              artifactSha256:
                "f897d0454ff6728a836b3e81b34afbc47900d6b40c5477d25d6c9ef5bc0ec186",
              immutableReferences: {
                "3284": [
                  {
                    start: 240,
                    length: 32,
                  },
                  {
                    start: 1066,
                    length: 32,
                  },
                  {
                    start: 2840,
                    length: 32,
                  },
                  {
                    start: 4429,
                    length: 32,
                  },
                ],
                "3286": [
                  {
                    start: 442,
                    length: 32,
                  },
                  {
                    start: 1176,
                    length: 32,
                  },
                  {
                    start: 4276,
                    length: 32,
                  },
                  {
                    start: 5600,
                    length: 32,
                  },
                ],
                "3289": [
                  {
                    start: 362,
                    length: 32,
                  },
                  {
                    start: 2616,
                    length: 32,
                  },
                ],
              },
              immutableValues: {
                "3284": [
                  "0x00000000000000000000000075798463024bda64d83c94a64bc7d7eab41300ef",
                ],
                "3286": [
                  "0x0000000000000000000000000000000071727de22e5e9d8baf0edac6f37da032",
                ],
                "3289": [
                  "0x0000000000000000000000000000000000000000000000000000000000000000",
                ],
              },
              compiler: {
                version: "0.8.30+commit.73712a01",
              },
              compilationTarget: {
                "src/Safe7579Launchpad.sol": "Safe7579Launchpad",
              },
              normalizedRuntimeKeccak256:
                "0x1d64c403ee087140ea16ad4de4e4ed039f9baac2abcc1071c039d3e2f8a6e43f",
              matchType: "exactAfterZeroingDeclaredImmutableLocations",
            },
          ],
        },
      },
      originalContractsObservedPresent: [
        "safeSingletonFactory",
        "safeSingleton",
        "safeProxyFactory",
        "adapterV1",
        "launchpadV1",
        "smartSessionLegacy",
        "ownableV1",
        "ownableLegacy",
        "compatibilityV1",
        "uniActionV1",
        "valueLimitV1",
        "timeFrameV1",
        "entryPoint07",
        "emissary",
      ],
      method:
        "eth_chainId; eth_getBlockByNumber; eth_getCode at fixed block number; block hash recheck",
    },
    {
      chainId: 10,
      publicRpcUrl: "https://mainnet.optimism.io",
      blockNumber: 156579447,
      blockHash:
        "0xab737fcfb47a12b7f6cc76ce82ea43f89b8350bf5cf1046931173151f6f340fe",
      chainIdVerified: true,
      blockHashRechecked: true,
      originalContractsObservedPresent: [
        "safeSingletonFactory",
        "safeSingleton",
        "safeProxyFactory",
        "adapterV1",
        "launchpadV1",
        "smartSessionLegacy",
        "ownableV1",
        "ownableLegacy",
        "compatibilityV1",
        "uniActionV1",
        "valueLimitV1",
        "timeFrameV1",
        "entryPoint07",
        "emissary",
      ],
      method:
        "eth_chainId; eth_getBlockByNumber; eth_getCode at fixed block number; block hash recheck",
    },
    {
      chainId: 8453,
      publicRpcUrl: "https://mainnet.base.org",
      blockNumber: 50984162,
      blockHash:
        "0x815e5df82f7fc315301812d724531c676b2cd12494fe48522ad18e05bbac6dfa",
      chainIdVerified: true,
      blockHashRechecked: true,
      originalContractsObservedPresent: [
        "safeSingletonFactory",
        "safeSingleton",
        "safeProxyFactory",
        "adapterV1",
        "launchpadV1",
        "smartSessionLegacy",
        "ownableV1",
        "ownableLegacy",
        "compatibilityV1",
        "uniActionV1",
        "valueLimitV1",
        "timeFrameV1",
        "entryPoint07",
        "emissary",
      ],
      method:
        "eth_chainId; eth_getBlockByNumber; eth_getCode at fixed block number; block hash recheck",
    },
    {
      chainId: 42161,
      publicRpcUrl: "https://arb1.arbitrum.io/rpc",
      blockNumber: 502573441,
      blockHash:
        "0x22a32106b4b6d0b2817ab37d7c8643263d0c680f8b25a52dfa20e22ffdcca3ef",
      chainIdVerified: true,
      blockHashRechecked: true,
      originalContractsObservedPresent: [
        "safeSingletonFactory",
        "safeSingleton",
        "safeProxyFactory",
        "adapterV1",
        "launchpadV1",
        "smartSessionLegacy",
        "ownableV1",
        "ownableLegacy",
        "compatibilityV1",
        "uniActionV1",
        "valueLimitV1",
        "timeFrameV1",
        "entryPoint07",
        "emissary",
      ],
      method:
        "eth_chainId; eth_getBlockByNumber; eth_getCode at fixed block number; block hash recheck",
    },
    {
      chainId: 11155111,
      publicRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
      blockNumber: 11652036,
      blockHash:
        "0xb89c6621df87dd2ccf1c9eaa39abcac5f0ad94ce207163d8a4e6100421c987ca",
      chainIdVerified: true,
      blockHashRechecked: true,
      additionalCode: {
        adapterLegacy: {
          address: "0x7579EE8307284F293B1927136486880611F20002",
          bytes: 20014,
          keccak256:
            "0xe03f1efc4aa74c91a87731397278a9c32d81f593263931fc94ff867aa09b83ac",
          artifactBindings: [],
        },
        launchpadLegacy: {
          address: "0x7579011aB74c46090561ea277Ba79D510c6C00ff",
          bytes: 11335,
          keccak256:
            "0xe15c7413325ecf9e9fe60a315a0c9b49ad3003f3e6c254b9fa841dff8a8a32a5",
          artifactBindings: [],
        },
        uniActionLegacy: {
          address: "0x0000006DDA6c463511C4e9B05CFc34C1247fCF1F",
          bytes: 3084,
          keccak256:
            "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
          artifactBindings: [
            {
              artifact:
                "https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/UniActionPolicy/UniActionPolicy.json",
              artifactSha256:
                "b385f7a360b31f1a0e4ab36794bbebd71574317527a411478b3b6f498cfadd22",
              immutableReferences: {},
              immutableValues: {},
              compiler: {
                version: "0.8.28+commit.7893614a",
              },
              compilationTarget: {
                "contracts/external/policies/UniActionPolicy.sol":
                  "UniActionPolicy",
              },
              normalizedRuntimeKeccak256:
                "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
              matchType: "exactRuntime",
            },
          ],
        },
        valueLimitLegacy: {
          address: "0x730DA93267E7E513e932301B47F2ac7D062abC83",
          bytes: 3192,
          keccak256:
            "0xc5efddfaf9a5fad8cb996f1fd03056926af11ebd4496a7a7758e2e4315a7865e",
          artifactBindings: [],
        },
        timeFrameLegacy: {
          address: "0x8177451511dE0577b911C254E9551D981C26dc72",
          bytes: 2539,
          keccak256:
            "0xfe83529b2df328020b49b8e728f62e571e21a38b3b7e59e75d6c6629a38cd87c",
          artifactBindings: [],
        },
        emissary: {
          address: "0xad568b3f825a8d5ffc06dd3253526b64d810ae89",
          bytes: 23507,
          keccak256:
            "0xaa8252d18e8c0868ef1cfba599d28f382ce17ce8850a83066562b06675193bdf",
          artifactBindings: [],
        },
        adapterV1: {
          address: "0x7579f2AD53b01c3D8779Fe17928e0D48885B0003",
          bytes: 23929,
          keccak256:
            "0xc9c3866bdfbdb586211254dbe457aa3d1c9fd1acf1bbaa36e4c86c3ebc156b69",
          artifactBindings: [
            {
              artifact:
                "https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579/Safe7579.json",
              artifactSha256:
                "5e40d3584872cd8bc0cea680f720a69c1cc49656e3f69e796deed718bb7cd37c",
              immutableReferences: {
                "7146": [
                  {
                    start: 5535,
                    length: 32,
                  },
                  {
                    start: 6055,
                    length: 32,
                  },
                  {
                    start: 6446,
                    length: 32,
                  },
                  {
                    start: 8315,
                    length: 32,
                  },
                  {
                    start: 10226,
                    length: 32,
                  },
                  {
                    start: 16832,
                    length: 32,
                  },
                  {
                    start: 17040,
                    length: 32,
                  },
                  {
                    start: 18409,
                    length: 32,
                  },
                  {
                    start: 18714,
                    length: 32,
                  },
                ],
              },
              immutableValues: {
                "7146": [
                  "0x0000000000000000000000003fb7a8bee59d8c5b2f1cf6ce93e5e694cb233b57",
                ],
              },
              compiler: {
                version: "0.8.30+commit.73712a01",
              },
              compilationTarget: {
                "src/Safe7579.sol": "Safe7579",
              },
              normalizedRuntimeKeccak256:
                "0xc13aace33937bd17e9f13cd4dbf11d2e143c774a2f53bc7f3cfc22706b87034f",
              matchType: "exactAfterZeroingDeclaredImmutableLocations",
            },
          ],
        },
        launchpadV1: {
          address: "0x75798463024Bda64D83c94A64Bc7D7eaB41300eF",
          bytes: 11726,
          keccak256:
            "0x044b5e0086072ca4cb8e39c4d7fe5ae78def953b347eacd8d3abbba56946fb6e",
          artifactBindings: [
            {
              artifact:
                "https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579Launchpad/Safe7579Launchpad.json",
              artifactSha256:
                "f897d0454ff6728a836b3e81b34afbc47900d6b40c5477d25d6c9ef5bc0ec186",
              immutableReferences: {
                "3284": [
                  {
                    start: 240,
                    length: 32,
                  },
                  {
                    start: 1066,
                    length: 32,
                  },
                  {
                    start: 2840,
                    length: 32,
                  },
                  {
                    start: 4429,
                    length: 32,
                  },
                ],
                "3286": [
                  {
                    start: 442,
                    length: 32,
                  },
                  {
                    start: 1176,
                    length: 32,
                  },
                  {
                    start: 4276,
                    length: 32,
                  },
                  {
                    start: 5600,
                    length: 32,
                  },
                ],
                "3289": [
                  {
                    start: 362,
                    length: 32,
                  },
                  {
                    start: 2616,
                    length: 32,
                  },
                ],
              },
              immutableValues: {
                "3284": [
                  "0x00000000000000000000000075798463024bda64d83c94a64bc7d7eab41300ef",
                ],
                "3286": [
                  "0x0000000000000000000000000000000071727de22e5e9d8baf0edac6f37da032",
                ],
                "3289": [
                  "0x0000000000000000000000000000000000000000000000000000000000000000",
                ],
              },
              compiler: {
                version: "0.8.30+commit.73712a01",
              },
              compilationTarget: {
                "src/Safe7579Launchpad.sol": "Safe7579Launchpad",
              },
              normalizedRuntimeKeccak256:
                "0x1d64c403ee087140ea16ad4de4e4ed039f9baac2abcc1071c039d3e2f8a6e43f",
              matchType: "exactAfterZeroingDeclaredImmutableLocations",
            },
          ],
        },
      },
      originalContractsObservedPresent: [
        "safeSingletonFactory",
        "safeSingleton",
        "safeProxyFactory",
        "adapterV1",
        "launchpadV1",
        "smartSessionLegacy",
        "ownableV1",
        "ownableLegacy",
        "compatibilityV1",
        "uniActionV1",
        "valueLimitV1",
        "timeFrameV1",
        "entryPoint07",
        "emissary",
      ],
      method:
        "eth_chainId; eth_getBlockByNumber; eth_getCode at fixed block number; block hash recheck",
    },
    {
      chainId: 11155420,
      publicRpcUrl: "https://sepolia.optimism.io",
      blockNumber: 48477566,
      blockHash:
        "0x68a1c7449262878d677749b63cc524183e55eb9759ded063482700d877d0af85",
      chainIdVerified: true,
      blockHashRechecked: true,
      originalContractsObservedPresent: [
        "safeSingletonFactory",
        "safeSingleton",
        "safeProxyFactory",
        "adapterV1",
        "launchpadV1",
        "smartSessionLegacy",
        "ownableV1",
        "ownableLegacy",
        "compatibilityV1",
        "uniActionV1",
        "valueLimitV1",
        "timeFrameV1",
        "entryPoint07",
        "emissary",
      ],
      method:
        "eth_chainId; eth_getBlockByNumber; eth_getCode at fixed block number; block hash recheck",
    },
    {
      chainId: 84532,
      publicRpcUrl: "https://sepolia.base.org",
      blockNumber: 46494692,
      blockHash:
        "0xdbd170a4abf2de2c4dc02f9e611e0548e0f838d01fbe8dca1339e35923a8732b",
      chainIdVerified: true,
      blockHashRechecked: true,
      originalContractsObservedPresent: [
        "safeSingletonFactory",
        "safeSingleton",
        "safeProxyFactory",
        "adapterV1",
        "launchpadV1",
        "smartSessionLegacy",
        "ownableV1",
        "ownableLegacy",
        "compatibilityV1",
        "uniActionV1",
        "valueLimitV1",
        "timeFrameV1",
        "entryPoint07",
        "emissary",
      ],
      method:
        "eth_chainId; eth_getBlockByNumber; eth_getCode at fixed block number; block hash recheck",
    },
    {
      chainId: 421614,
      publicRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
      blockNumber: 306272332,
      blockHash:
        "0x9810773939c9bda0851c9366577572df347faae8da87e47d75482ca81112fd35",
      chainIdVerified: true,
      blockHashRechecked: true,
      originalContractsObservedPresent: [
        "safeSingletonFactory",
        "safeSingleton",
        "safeProxyFactory",
        "adapterV1",
        "launchpadV1",
        "smartSessionLegacy",
        "ownableV1",
        "ownableLegacy",
        "compatibilityV1",
        "uniActionV1",
        "valueLimitV1",
        "timeFrameV1",
        "entryPoint07",
        "emissary",
      ],
      method:
        "eth_chainId; eth_getBlockByNumber; eth_getCode at fixed block number; block hash recheck",
    },
  ],
  compiledPolicySources: [
    {
      name: "TimeFramePolicy",
      path: "contracts/external/policies/TimeFramePolicy.sol",
      sha256:
        "526127a407f19ce4b7bae2dd95ec93bbd6507918d301adc2c8b012fe499899d6",
      keccak256:
        "0x9c807f133e8493f68ea32d683de245e5c0c12550b7023ae41190be3ce8f8930b",
      verificationInputSha256:
        "3ae697fb76203b90e7987e0d31db73afb616432797f2c7120dd5ef8eccb8784b",
      verificationInputUrl:
        "https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/TimeFramePolicy/verify.json",
      compiler: "0.8.28+commit.7893614a",
      artifactMetadataSourceKeccakMatches: true,
    },
    {
      name: "UniActionPolicy",
      path: "contracts/external/policies/UniActionPolicy.sol",
      sha256:
        "bdb7043e014e2a9352fe16f2a7bbf863415c56766ea365ee283c2b15ca894f35",
      keccak256:
        "0x7a0b8e99adcd784d29d02323f04fee8b51fb28dee27fc503b621e519f879c122",
      verificationInputSha256:
        "bce58e32aa636218daa41a93c986caf3a41c902505a16a958097fe12e8ca81d8",
      verificationInputUrl:
        "https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/UniActionPolicy/verify.json",
      compiler: "0.8.28+commit.7893614a",
      artifactMetadataSourceKeccakMatches: true,
    },
    {
      name: "ValueLimitPolicy",
      path: "contracts/external/policies/ValueLimitPolicy.sol",
      sha256:
        "7e9130987a1cbc2e00c8310dcc3223a3c2a6373a9472c0427101a03c1848c4eb",
      keccak256:
        "0x94734aae2a6eb7b195b991aa0423db771474d79009038098b2f22be084fe8a75",
      verificationInputSha256:
        "bc7723b4e43735c3b4ea5ea523241d04a934d03dc6838a8665f8f1792ea06fac",
      verificationInputUrl:
        "https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/ValueLimitPolicy/verify.json",
      compiler: "0.8.28+commit.7893614a",
      artifactMetadataSourceKeccakMatches: true,
    },
  ],
  localCompiledSources: [
    "/private/tmp/center-smart-source-SmartSession-NonceManager.sol",
    "/private/tmp/center-smart-source-SmartSession-PolicyLib.sol",
    "/private/tmp/center-smart-source-SmartSession-SmartSession.sol",
    "/private/tmp/center-smart-source-SmartSession-SmartSessionBase.sol",
    "/private/tmp/center-smart-source-UniActionPolicy-NonceManager.sol",
    "/private/tmp/center-smart-source-UniActionPolicy-UniActionPolicy.sol",
    "/private/tmp/center-smart-source-ValueLimitPolicy-NonceManager.sol",
    "/private/tmp/center-smart-source-ValueLimitPolicy-ValueLimitPolicy.sol",
  ],
  recommendation: {
    candidate:
      "Legacy ERC4337 SmartSession validator with individually pinned current TimeFrame/UniAction/ValueLimit policies and current source-bound Safe7579 adapter/launchpad.",
    activationApproved: false,
    unresolved: [
      "EntryPoint0.7 observed bytecode is not yet bound to an exact source artifact.",
      "SafeProxy runtime source artifact is not yet bound.",
      "Safe7579 delegated utility0x3fb7a8bee59d8c5b2f1cf6ce93e5e694cb233b57 is not yet independently source-bound.",
      "Ownable session-key validator source artifact is not yet bound.",
      "Actual account configuration and end-to-end validation/execution have not been tested by this research task.",
      "Legacy adapter/launchpad do not match sampled historical artifacts.",
      "Legacy TimeFrame/ValueLimit addresses have no code on Ethereum at observed block; Sepolia code exists but source unbound.",
      "Emissary current HEAD action path discards TimeFrame validation data, but deployed runtime does not match HEAD artifact after immutable normalization; deployed expiry issue remains unproven.",
    ],
    revocationRequirement:
      "Parent independently confirmed legacy removeSession does not bump enable nonce; account must separately revokeEnableSignature(permissionId).",
  },
  rejectedArtifacts: [
    {
      localPath:
        "/private/tmp/center-smart-REJECTED-EntryPoint-v0.6-artifact.json",
      reason:
        "Official releases/v0.7 branch committed deployments/sepolia/EntryPoint.json is stale v0.6 address0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789 with mismatched runtime; do not use for EntryPoint0.7.",
      repository: "https://github.com/eth-infinitism/account-abstraction",
      commit: "7af70c8993a6f42973f520ae0752386a5032abe7",
    },
  ],
} as const;
