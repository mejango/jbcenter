// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CenterSessionGuardV2, PackedUserOperation} from "../contracts/CenterSessionGuardV2.sol";

interface CurrentStackVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function projectRoot() external view returns (string memory);
    function etch(address target, bytes calldata code) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function prank(address msgSender, address txOrigin) external;
    function deal(address target, uint256 balance) external;
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function warp(uint256 timestamp) external;
    function fee(uint256 basefee) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

struct ModuleInit {
    address module;
    bytes initData;
    uint256 moduleType;
}

struct PolicyData {
    address policy;
    bytes initData;
}

struct Content {
    bytes32 appDomainSeparator;
    string[] contentNames;
}

struct ERC7739Data {
    Content[] allowedERC7739Content;
    PolicyData[] erc1271Policies;
}

struct ActionData {
    bytes4 actionTargetSelector;
    address actionTarget;
    PolicyData[] actionPolicies;
}

struct SessionData {
    address sessionValidator;
    bytes sessionValidatorInitData;
    bytes32 salt;
    PolicyData[] userOpPolicies;
    ERC7739Data erc7739Policies;
    ActionData[] actions;
    bool permitERC4337Paymaster;
}

struct Usage {
    uint256 limit;
    uint256 used;
}

struct Rule {
    uint8 condition;
    uint64 offset;
    bool isLimited;
    bytes32 ref;
    Usage usage;
}

struct Rules {
    uint256 length;
    Rule[16] rules;
}

struct ActionConfig {
    uint256 valueLimitPerUse;
    Rules paramRules;
}

interface CurrentStackEntryPoint {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata op) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable receiver, uint256 amount) external;
}

interface CurrentStackSafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;
    function validateUserOp(PackedUserOperation calldata op, bytes32 hash, uint256 missingFunds)
        external
        returns (uint256);
    function nonce() external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external returns (bool);
    function isModuleEnabled(address module) external view returns (bool);
}

interface CurrentStackFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 salt)
        external
        returns (address);
}

interface CurrentStackLaunchpad {
    function addSafe7579(address adapter, ModuleInit[] calldata modules, address[] calldata attesters, uint8 threshold)
        external;
}

interface CurrentStackSessions {
    function onInstall(bytes calldata data) external;
    function getPermissionId(SessionData calldata session) external pure returns (bytes32);
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
    function removeSession(bytes32 permissionId) external;
    function revokeEnableSignature(bytes32 permissionId) external;
    function getNonce(bytes32 permissionId, address account) external view returns (uint256);
}

interface CurrentStackPimlicoPaymaster {
    function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32 hash, uint256 requiredPrefund)
        external
        returns (bytes memory context, uint256 validationData);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function signers(address account) external view returns (bool);
    function isBundlerAllowed(address bundler) external view returns (bool);
    function addSigner(address signer) external;
    function updateBundlerAllowlist(address[] calldata bundlers, bool allowed) external;
    function deposit() external payable;
    function withdrawTo(address payable receiver, uint256 amount) external;
    function getHash(uint8 mode, PackedUserOperation calldata op) external view returns (bytes32);
}

/// @dev V6 pay ABI and caller/value observation fixture; not a production terminal deployment.
contract CurrentStackV6PayFixture {
    bool public reject;
    uint256 public calls;
    address public payer;
    address public beneficiary;
    uint256 public paid;

    function setReject(bool value) external {
        reject = value;
    }

    function pay(
        uint256 projectId,
        address token,
        uint256 amount,
        address recipient,
        uint256 minimum,
        string calldata memo,
        bytes calldata metadata
    ) external payable returns (uint256) {
        require(!reject, "fixture action rejected");
        require(
            projectId == 123 && token == address(0xEEEe) && amount == msg.value && minimum == 0, "wrong payment terms"
        );
        require(bytes(memo).length == 0 && metadata.length == 0, "nonempty payload");
        calls++;
        payer = msg.sender;
        beneficiary = recipient;
        paid += msg.value;
        return msg.value;
    }
}

contract FullStackV2Test {
    CurrentStackVm private constant vm = CurrentStackVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address private constant SMART = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address private constant OWNABLE = 0x2483DA3A338895199E5e538530213157e931Bf06;
    address private constant ADAPTER = 0x7579f2AD53b01c3D8779Fe17928e0D48885B0003;
    address private constant LAUNCH = 0x75798463024Bda64D83c94A64Bc7D7eaB41300eF;
    address private constant SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address private constant FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address private constant TIME = 0x0000000000D30f611fA3bf652ac6879428586930;
    address private constant UNI = 0x0000000000714Cf48FcF88A0bFBa70d313415032;
    address private constant VALUE = 0x000000000021dC45451291BCDfc9f0B46d6f0278;
    address private constant PAYMASTER = 0x777777777777AeC03fd955926DbF81597e66834C;
    bytes32 private constant PAYMASTER_CODE_HASH = 0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc;
    uint256 private constant GAS_PER_OPERATION = 2_800_000;
    uint256 private constant OWNER_KEY = 0x11112345;
    uint256 private constant BOT_KEY = 0x22223456;
    uint256 private constant PAYMASTER_KEY = 0x33334567;
    address private constant RECIPIENT = address(0xA123);
    address payable private constant BUNDLER = payable(address(0xB456));
    CurrentStackEntryPoint private entryPoint = CurrentStackEntryPoint(EP);
    CurrentStackSafe private safe;
    CurrentStackPimlicoPaymaster private sponsor;
    CurrentStackV6PayFixture private terminal;
    CenterSessionGuardV2 private guard;
    bytes32 private permissionId;
    bytes32 private configId;
    uint48 private validUntil;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.fee(1 gwei);
        vm.deal(address(this), 100 ether);
        _etch("EntryPoint", EP, true);
        _etch("SenderCreator", 0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C, false);
        _etch("Safe7579", ADAPTER, true);
        _etch("Safe7579Launchpad", LAUNCH, true);
        _etch("Safe7579DCUtil", 0x3fB7a8Bee59D8C5b2F1Cf6CE93e5E694Cb233B57, false);
        _etch("SafeL2", SINGLETON, false);
        _etch("SafeProxyFactory", FACTORY, false);
        _etch("SmartSession", SMART, false);
        _etch("OwnableValidator", OWNABLE, false);
        _etch("TimeFramePolicy", TIME, false);
        _etch("UniActionPolicy", UNI, false);
        _etch("ValueLimitPolicy", VALUE, false);
        guard = new CenterSessionGuardV2();
        require(
            address(guard).codehash == 0xb8787af1b7dad3b5fac11ec656824adbe575610ee467661be4acde928e3d7c04,
            "guard runtime does not match checked artifact"
        );
        string memory sponsorJson =
            vm.readFile(string.concat(vm.projectRoot(), "/artifacts/PimlicoSingletonPaymasterV7.json"));
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(PAYMASTER_KEY);
        bytes memory sponsorCreation = abi.encodePacked(
            vm.parseJsonBytes(sponsorJson, ".bytecode"), abi.encode(EP, address(this), address(this), signers)
        );
        address reproduced;
        assembly { reproduced := create(0, add(sponsorCreation, 32), mload(sponsorCreation)) }
        require(reproduced.codehash == PAYMASTER_CODE_HASH, "paymaster runtime mismatch");
        vm.etch(PAYMASTER, reproduced.code);
        require(PAYMASTER.codehash == PAYMASTER_CODE_HASH, "fixed-address runtime mismatch");
        sponsor = CurrentStackPimlicoPaymaster(PAYMASTER);
        // Local-only fixture bootstrap: verified OZ AccessControl _roles occupies slot zero.
        // Etching carries runtime/immutables but no constructor storage. Grant this test the
        // admin role, then configure its local signing key and bundler using real public methods.
        bytes32 roleSlot = keccak256(abi.encode(bytes32(0), uint256(0)));
        vm.store(PAYMASTER, keccak256(abi.encode(address(this), roleSlot)), bytes32(uint256(1)));
        require(sponsor.hasRole(bytes32(0), address(this)), "fixture admin role missing");
        sponsor.addSigner(vm.addr(PAYMASTER_KEY));
        _allowBundler(true);
        require(sponsor.signers(vm.addr(PAYMASTER_KEY)), "fixture signer missing");
        terminal = new CurrentStackV6PayFixture();
        _createSafe(4242);
        sponsor.deposit{value: 10 ether}();
        _install();
    }

    function _createSafe(uint256 salt) private {
        ModuleInit[] memory modules = new ModuleInit[](1);
        modules[0] = ModuleInit(SMART, "", 1);
        address[] memory owners = new address[](1);
        owners[0] = vm.addr(OWNER_KEY);
        bytes memory initialize = abi.encodeCall(
            CurrentStackSafe.setup,
            (
                owners,
                1,
                LAUNCH,
                abi.encodeCall(CurrentStackLaunchpad.addSafe7579, (ADAPTER, modules, new address[](0), 0)),
                ADAPTER,
                address(0),
                0,
                address(0)
            )
        );
        safe = CurrentStackSafe(CurrentStackFactory(FACTORY).createProxyWithNonce(SINGLETON, initialize, salt));
        require(safe.isModuleEnabled(ADAPTER), "adapter module missing");
        vm.deal(address(safe), 5 ether);
        permissionId = bytes32(0);
    }

    function _etch(string memory name, address target, bool patched) private {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../artifacts/", name, ".json"));
        vm.etch(target, vm.parseJsonBytes(json, patched ? ".deployedRuntimeBytecode" : ".deployedBytecode"));
    }

    function _equal(uint64 offset, bytes32 value) private pure returns (Rule memory) {
        return Rule(0, offset, false, value, Usage(0, 0));
    }

    function _install() private {
        _installWithBudgets(10_000_000, 0.1 ether, 2);
    }

    function _installWithBudgets(uint256 totalGas, uint256 totalCost, uint128 maximumCalls) private {
        SessionData[] memory sessions = new SessionData[](1);
        SessionData memory s;
        s.sessionValidator = OWNABLE;
        address[] memory bots = new address[](1);
        bots[0] = vm.addr(BOT_KEY);
        s.sessionValidatorInitData = abi.encode(uint256(1), bots);
        s.salt = keccak256(abi.encode("current-pimlico-full-stack-generation-1", totalGas, totalCost, maximumCalls));
        validUntil = uint48(block.timestamp + 7 days);
        s.userOpPolicies = new PolicyData[](3);
        s.userOpPolicies[0] = PolicyData(TIME, abi.encodePacked(validUntil, uint48(block.timestamp)));
        s.userOpPolicies[1] = PolicyData(
            address(guard),
            abi.encode(
                CenterSessionGuardV2.Config(
                    address(sponsor),
                    address(sponsor).codehash,
                    5_000_000,
                    2 gwei,
                    1 gwei,
                    totalGas,
                    totalCost,
                    maximumCalls,
                    130
                )
            )
        );
        s.userOpPolicies[2] = PolicyData(VALUE, abi.encode(uint256(1 ether)));
        s.erc7739Policies = ERC7739Data(new Content[](0), new PolicyData[](0));
        s.actions = new ActionData[](1);
        s.actions[0].actionTarget = address(terminal);
        s.actions[0].actionTargetSelector = terminal.pay.selector;
        s.actions[0].actionPolicies = new PolicyData[](1);
        ActionConfig memory a;
        a.valueLimitPerUse = 0.6 ether;
        a.paramRules.length = 9;
        a.paramRules.rules[0] = _equal(0, bytes32(uint256(123)));
        a.paramRules.rules[1] = _equal(32, bytes32(uint256(uint160(address(0xEEEe)))));
        a.paramRules.rules[2] = _equal(96, bytes32(uint256(uint160(RECIPIENT))));
        a.paramRules.rules[3] = _equal(128, 0);
        a.paramRules.rules[4] = _equal(160, bytes32(uint256(224)));
        a.paramRules.rules[5] = _equal(192, bytes32(uint256(256)));
        a.paramRules.rules[6] = _equal(224, 0);
        a.paramRules.rules[7] = _equal(256, 0);
        a.paramRules.rules[8] = Rule(4, 64, true, bytes32(uint256(0.6 ether)), Usage(1 ether, 0));
        s.actions[0].actionPolicies[0] = PolicyData(UNI, abi.encode(a));
        s.permitERC4337Paymaster = true;
        sessions[0] = s;
        permissionId = CurrentStackSessions(SMART).getPermissionId(s);
        configId = keccak256(abi.encodePacked(address(safe), permissionId));
        bytes memory enableData =
            abi.encodeCall(CurrentStackSessions.onInstall, (abi.encodePacked(bytes1(0x02), abi.encode(sessions))));
        require(_ownerCall(SMART, 0, enableData, OWNER_KEY), "owner session enable failed");
        require(
            CurrentStackSessions(SMART).isPermissionEnabled(permissionId, address(safe)),
            "owner session activation failed"
        );
    }

    function _ownerCall(address target, uint256 amount, bytes memory data, uint256 key) private returns (bool) {
        bytes32 digest = safe.getTransactionHash(target, amount, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return safe.execTransaction(
            target, amount, data, 0, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v)
        );
    }

    function _allowBundler(bool allowed) private {
        address[] memory bundlers = new address[](1);
        bundlers[0] = BUNDLER;
        sponsor.updateBundlerAllowlist(bundlers, allowed);
        require(sponsor.isBundlerAllowed(BUNDLER) == allowed, "bundler setup failed");
    }

    function _operation(uint256 amount) private view returns (PackedUserOperation memory op) {
        return _operationWithFlags(amount, 0);
    }

    function _operationWithFlags(uint256 amount, uint8 flags) private view returns (PackedUserOperation memory op) {
        op.sender = address(safe);
        op.nonce = entryPoint.getNonce(address(safe), uint192(uint160(SMART)) << 32);
        bytes memory inner = abi.encodeCall(terminal.pay, (123, address(0xEEEe), amount, RECIPIENT, 0, "", bytes("")));
        op.callData = abi.encodeWithSelector(
            guard.EXECUTE_SELECTOR(), bytes32(0), abi.encodePacked(address(terminal), amount, inner)
        );
        op.accountGasLimits = bytes32((uint256(2_000_000) << 128) | 500_000);
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 2 gwei);
        op.paymasterAndData = abi.encodePacked(
            address(sponsor), uint128(100_000), uint128(100_000), bytes1(flags), validUntil, uint48(0), new bytes(65)
        );
        return _signSponsor(op, 0);
    }

    function _signSponsor(PackedUserOperation memory op, uint8 mode) private view returns (PackedUserOperation memory) {
        // getHash takes decoded mode 0 for both flags 0x00 and 0x01. The flag is bound
        // through paymasterAndData in the current runtime's EIP-191 signing digest.
        bytes32 sponsorDigest =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", sponsor.getHash(mode, op)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYMASTER_KEY, sponsorDigest);
        bytes memory signature = abi.encodePacked(r, s, v);
        uint256 start = op.paymasterAndData.length - 65;
        for (uint256 i; i < 65; ++i) {
            op.paymasterAndData[start + i] = signature[i];
        }
        return op;
    }

    function _sign(PackedUserOperation memory op, uint256 key) private view returns (PackedUserOperation memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", entryPoint.getUserOpHash(op)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.signature = abi.encodePacked(bytes1(0), permissionId, r, s, v);
        return op;
    }

    function _submit(PackedUserOperation memory op) private returns (bytes32 hash) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sign(op, BOT_KEY);
        hash = entryPoint.getUserOpHash(op);
        vm.prank(BUNDLER, BUNDLER);
        entryPoint.handleOps(ops, BUNDLER);
    }

    function _rejected(PackedUserOperation memory op) private {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sign(op, BOT_KEY);
        vm.prank(BUNDLER, BUNDLER);
        (bool ok,) = EP.call(abi.encodeCall(entryPoint.handleOps, (ops, BUNDLER)));
        require(!ok, "forbidden operation executed");
    }

    function _rejectedByAccount(PackedUserOperation memory op) private {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sign(op, BOT_KEY);
        vm.prank(BUNDLER, BUNDLER);
        (bool ok, bytes memory reason) = EP.call(abi.encodeCall(entryPoint.handleOps, (ops, BUNDLER)));
        require(!ok, "forbidden operation executed");
        require(
            keccak256(reason)
                == keccak256(
                    abi.encodeWithSignature(
                        "FailedOpWithRevert(uint256,string,bytes)",
                        0,
                        "AA23 reverted",
                        abi.encodeWithSignature("ExecutionFailed()")
                    )
                ),
            "expected account policy failure, not paymaster rejection"
        );
    }

    function _rejectedByGuard(PackedUserOperation memory op) private {
        // Pinned SmartSession reverts on guard failure, Safe7579 wraps it in ExecutionFailed,
        // and EntryPoint reports AA23 before invoking paymaster validation. Verify both the
        // policy result and the actual account failure; a generic handleOps revert could
        // instead be a downstream paymaster parser or signature rejection.
        uint128 calls = _callsUsed();
        vm.prank(SMART, BUNDLER);
        require(guard.checkUserOpPolicy(configId, op) == 1, "guard accepted forbidden operation");
        _rejectedByAccount(op);
        require(_callsUsed() == calls, "rejected guard mutated usage");
    }

    function _assertSponsorValid(PackedUserOperation memory op) private {
        address paymaster = address(bytes20(op.paymasterAndData));
        bytes32 hash = entryPoint.getUserOpHash(op);
        vm.prank(EP, BUNDLER);
        (, uint256 validationData) =
            CurrentStackPimlicoPaymaster(paymaster).validatePaymasterUserOp(op, hash, GAS_PER_OPERATION * 2 gwei);
        require(uint160(validationData) == 0, "negative fixture has invalid paymaster signature");
        uint48 until = uint48(validationData >> 160);
        uint48 afterTime = uint48(validationData >> 208);
        require(block.timestamp >= afterTime && (until == 0 || block.timestamp <= until), "paymaster time invalid");
    }

    function _callsUsed() private view returns (uint128 calls) {
        (,,, calls) = guard.getConfig(configId, SMART, address(safe));
    }

    function _assertUsage(uint128 calls) private view {
        (, uint256 gasUsed, uint256 costUsed, uint128 callsUsed) = guard.getConfig(configId, SMART, address(safe));
        require(
            callsUsed == calls && gasUsed == GAS_PER_OPERATION * calls
                && costUsed == GAS_PER_OPERATION * calls * 2 gwei,
            "validation gas/cost/call accounting mismatch"
        );
    }

    function testFlag00FullPaymentAndReceiptUseSafePayerAndSponsorGas() public {
        uint256 deposit = entryPoint.balanceOf(address(sponsor));
        vm.recordLogs();
        bytes32 hash = _submit(_operation(0.4 ether));
        require(
            terminal.payer() == address(safe) && terminal.beneficiary() == RECIPIENT && terminal.paid() == 0.4 ether,
            "wrong caller/value"
        );
        require(
            address(safe).balance == 4.6 ether && entryPoint.balanceOf(address(safe)) == 0, "native account funded gas"
        );
        require(entryPoint.balanceOf(address(sponsor)) < deposit && BUNDLER.balance > 0, "sponsor did not pay bundler");
        bool observed;
        CurrentStackVm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == EP && logs[i].topics.length == 4
                    && logs[i].topics[0]
                        == keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
            ) {
                require(
                    logs[i].topics[1] == hash && address(uint160(uint256(logs[i].topics[2]))) == address(safe)
                        && address(uint160(uint256(logs[i].topics[3]))) == address(sponsor),
                    "receipt identity mismatch"
                );
                (, bool success, uint256 cost, uint256 gasUsed) =
                    abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                require(success && cost > 0 && gasUsed > 0, "receipt outcome missing");
                observed = true;
            }
        }
        require(observed && _callsUsed() == 1, "operation receipt or counters missing");
        _assertUsage(1);
    }

    function testFlag01ExecutesWithUnallowlistedBundler() public {
        _allowBundler(false);
        _submit(_operationWithFlags(0.4 ether, 1));
        require(terminal.payer() == address(safe) && terminal.paid() == 0.4 ether, "flag01 payment failed");
        require(address(safe).balance == 4.6 ether && entryPoint.balanceOf(address(safe)) == 0, "account funded gas");
        _assertUsage(1);
    }

    function testFlag00RequiresPaymasterBundlerAllowlistAndRollsBackUsage() public {
        _allowBundler(false);
        _rejected(_operationWithFlags(0.1 ether, 0));
        _assertUsage(0);
        _allowBundler(true);
        _submit(_operationWithFlags(0.1 ether, 0));
        _assertUsage(1);
    }

    function testBothERC20FlagsRejectAtAccountWithValidPaymasterSignatures() public {
        for (uint8 flags = 2; flags <= 3; ++flags) {
            PackedUserOperation memory op = _operation(0.1 ether);
            // Structurally valid current ERC20 mode, no precharge and no optional fields.
            // Fresh signatures exclude stale-signature rejection; token/postOp paths never execute.
            op.paymasterAndData = abi.encodePacked(
                PAYMASTER,
                uint128(100_000),
                uint128(100_000),
                bytes1(flags),
                bytes1(0),
                validUntil,
                uint48(0),
                address(0xC020),
                uint128(50_000),
                uint256(1e18),
                uint128(100_000),
                address(this),
                new bytes(65)
            );
            op = _signSponsor(op, 1);
            _assertSponsorValid(op);
            _rejectedByGuard(op);
        }
        _assertUsage(0);
        require(terminal.calls() == 0 && address(safe).balance == 5 ether, "ERC20 mode touched principal");
    }

    function testMalformedFlagsAndSignatureLengthsRejectInGuardAndActualAccount() public {
        PackedUserOperation memory op = _operation(0.1 ether);
        op.paymasterAndData[52] = 0x02;
        _rejectedByGuard(op);
        op = _operation(0.1 ether);
        op.paymasterAndData[52] = 0x03;
        _rejectedByGuard(op);
        op = _operation(0.1 ether);
        op.paymasterAndData[52] = 0xff;
        _rejectedByGuard(op);
        op = _operation(0.1 ether);
        bytes memory shortData = new bytes(129);
        for (uint256 i; i < shortData.length; ++i) {
            shortData[i] = op.paymasterAndData[i];
        }
        op.paymasterAndData = shortData;
        _rejectedByGuard(op);
        op = _operation(0.1 ether);
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, bytes1(0));
        _rejectedByGuard(op);
        require(terminal.calls() == 0 && address(safe).balance == 5 ether, "malformed data touched principal");
    }

    function testAddressSubstitutionRejectsAtAccountDespiteSamePaymasterRuntime() public {
        address alternate = address(0x7778);
        vm.etch(alternate, PAYMASTER.code);
        bytes32 roleSlot = keccak256(abi.encode(bytes32(0), uint256(0)));
        vm.store(alternate, keccak256(abi.encode(address(this), roleSlot)), bytes32(uint256(1)));
        CurrentStackPimlicoPaymaster(alternate).addSigner(vm.addr(PAYMASTER_KEY));
        CurrentStackPimlicoPaymaster(alternate).deposit{value: 1 ether}();
        PackedUserOperation memory op = _operationWithFlags(0.1 ether, 1);
        bytes20 encodedAddress = bytes20(alternate);
        for (uint256 i; i < 20; ++i) {
            op.paymasterAndData[i] = encodedAddress[i];
        }
        op = _signSponsor(op, 0);
        _assertSponsorValid(op);
        _rejectedByGuard(op);
        _assertUsage(0);
    }

    function testRuntimeMutationRejectsAtAccountWhilePaymasterStillValidates() public {
        PackedUserOperation memory op = _operation(0.1 ether);
        // An unreachable trailing byte changes extcodehash without changing paymaster execution.
        vm.etch(PAYMASTER, abi.encodePacked(PAYMASTER.code, bytes1(0)));
        require(PAYMASTER.codehash != PAYMASTER_CODE_HASH, "runtime did not change");
        _assertSponsorValid(op);
        _rejectedByGuard(op);
        _assertUsage(0);
    }

    function testBudgetAndCallCapsAreEnforcedWithoutBackend() public {
        _submit(_operation(0.6 ether));
        _rejectedByAccount(_operation(0.5 ether));
        _assertUsage(1);
        _submit(_operation(0.4 ether));
        _rejectedByGuard(_operation(1));
        require(terminal.paid() == 1 ether && _callsUsed() == 2, "budget accounting failed");
        _assertUsage(2);
    }

    function testTotalGasBudgetRejectsBeforeCallCountOrValueBudget() public {
        _createSafe(4243);
        _installWithBudgets(5_000_000, 0.1 ether, 10);
        _submit(_operation(0.1 ether));
        _rejectedByGuard(_operation(0.1 ether));
        _assertUsage(1);
        require(terminal.paid() == 0.1 ether, "gas budget allowed another action");
    }

    function testTotalSponsoredCostBudgetRejectsBeforeGasOrCallBudget() public {
        _createSafe(4243);
        _installWithBudgets(10_000_000, GAS_PER_OPERATION * 2 gwei, 10);
        _submit(_operation(0.1 ether));
        _rejectedByGuard(_operation(0.1 ether));
        _assertUsage(1);
        require(terminal.paid() == 0.1 ether, "cost budget allowed another action");
    }

    function testMissingSponsorAndHugeFeeCannotPrefundNativePrincipal() public {
        PackedUserOperation memory op = _operation(0.1 ether);
        op.paymasterAndData = "";
        _rejectedByGuard(op);
        op = _operation(0.1 ether);
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 3 gwei);
        _rejectedByGuard(_signSponsor(op, 0));
        op = _operation(0.1 ether);
        op.gasFees = bytes32(uint256(type(uint128).max));
        _rejected(op);
        require(
            address(safe).balance == 5 ether && entryPoint.balanceOf(address(safe)) == 0 && _callsUsed() == 0,
            "principal or counters changed"
        );
    }

    function testExpiryRevocationAndWrongSignerRejectAtEntryPoint() public {
        PackedUserOperation memory op = _operation(0.1 ether);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sign(op, OWNER_KEY);
        vm.prank(BUNDLER, BUNDLER);
        (bool ok,) = EP.call(abi.encodeCall(entryPoint.handleOps, (ops, BUNDLER)));
        require(!ok, "wrong bot signer accepted");
        vm.warp(validUntil + 1);
        op = _operation(0.1 ether);
        bytes6 sponsorUntil = bytes6(uint48(validUntil + 1 days));
        for (uint256 i; i < 6; ++i) {
            op.paymasterAndData[53 + i] = sponsorUntil[i];
        }
        op = _signSponsor(op, 0);
        _assertSponsorValid(op);
        ops[0] = _sign(op, BOT_KEY);
        vm.prank(BUNDLER, BUNDLER);
        bytes memory reason;
        (ok, reason) = EP.call(abi.encodeCall(entryPoint.handleOps, (ops, BUNDLER)));
        require(
            !ok
                && keccak256(reason)
                    == keccak256(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA22 expired or not due")),
            "expected session expiry with valid sponsor"
        );
        _assertUsage(0);
        vm.warp(validUntil - 1);
        uint256 nonce = CurrentStackSessions(SMART).getNonce(permissionId, address(safe));
        require(
            _ownerCall(SMART, 0, abi.encodeCall(CurrentStackSessions.removeSession, (permissionId)), OWNER_KEY),
            "owner revoke failed"
        );
        require(
            _ownerCall(SMART, 0, abi.encodeCall(CurrentStackSessions.revokeEnableSignature, (permissionId)), OWNER_KEY),
            "enable nonce revoke failed"
        );
        require(
            CurrentStackSessions(SMART).getNonce(permissionId, address(safe)) == nonce + 1, "enable nonce unchanged"
        );
        _rejected(_operation(0.1 ether));
    }

    function _recipientApproval(uint256 key) private view returns (bytes memory) {
        bytes32 digest =
            safe.getTransactionHash(RECIPIENT, 1 ether, "", 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodeCall(
            safe.execTransaction,
            (RECIPIENT, 1 ether, bytes(""), 0, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v))
        );
    }

    function testFreshOwnerSignatureAuthorizesFundMovementOutsideSession() public {
        PackedUserOperation memory op = _operation(0.1 ether);
        op.callData = abi.encodeWithSelector(
            guard.EXECUTE_SELECTOR(), bytes32(0), abi.encodePacked(RECIPIENT, uint256(1 ether), bytes4(0x12345678))
        );
        _rejectedByAccount(_signSponsor(op, 0));
        (bool ok,) = address(safe).call(_recipientApproval(BOT_KEY));
        require(!ok, "bot replaced owner approval");
        bytes memory approved = _recipientApproval(OWNER_KEY);
        bytes memory result;
        (ok, result) = address(safe).call(approved);
        require(ok && abi.decode(result, (bool)), "fresh owner transfer failed");
        (ok,) = address(safe).call(approved);
        require(!ok, "owner signature replay accepted");
        require(RECIPIENT.balance == 1 ether && address(safe).balance == 4 ether, "owner transfer amount wrong");
    }

    function testActionParameterBindingsRejectBeforeExecutionAndRollBackUsage() public {
        for (uint256 i; i < 5; ++i) {
            PackedUserOperation memory op = _operation(0.1 ether);
            bytes memory inner = abi.encodeCall(
                terminal.pay,
                (
                    i == 0 ? 124 : 123,
                    i == 1 ? address(0xBAD) : address(0xEEEe),
                    0.1 ether,
                    i == 2 ? address(0xBAD) : RECIPIENT,
                    i == 3 ? 1 : 0,
                    i == 4 ? "bad" : "",
                    bytes("")
                )
            );
            op.callData = abi.encodeWithSelector(
                guard.EXECUTE_SELECTOR(), bytes32(0), abi.encodePacked(address(terminal), uint256(0.1 ether), inner)
            );
            _rejectedByAccount(_signSponsor(op, 0));
            _assertUsage(0);
        }
        _rejectedByAccount(_operation(0.7 ether));
        _assertUsage(0);
        require(terminal.calls() == 0 && address(safe).balance == 5 ether, "action policy touched principal");
    }

    function testRevertedActionRetainsValidationCountersAndSponsorDepletionFailsClosed() public {
        terminal.setReject(true);
        uint256 deposit = entryPoint.balanceOf(address(sponsor));
        vm.recordLogs();
        bytes32 hash = _submit(_operation(0.1 ether));
        bool observedFailure;
        CurrentStackVm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == EP && logs[i].topics.length == 4
                    && logs[i].topics[0]
                        == keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
                    && logs[i].topics[1] == hash
            ) {
                (, bool success, uint256 gasCost,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                require(!success && gasCost > 0, "failed action reported success");
                observedFailure = true;
            }
        }
        require(observedFailure, "failed UserOperation receipt missing");
        require(
            _callsUsed() == 1 && terminal.paid() == 0 && address(safe).balance == 5 ether,
            "failed action accounting wrong"
        );
        require(entryPoint.balanceOf(address(sponsor)) < deposit, "failed action gas not charged sponsor");
        _assertUsage(1);
        sponsor.withdrawTo(payable(address(this)), entryPoint.balanceOf(address(sponsor)));
        terminal.setReject(false);
        _rejected(_operation(0.1 ether));
        require(
            _callsUsed() == 1 && entryPoint.balanceOf(address(safe)) == 0 && address(safe).balance == 5 ether,
            "depleted sponsor fell back to account"
        );
        _assertUsage(1);
    }
    receive() external payable {}
}
