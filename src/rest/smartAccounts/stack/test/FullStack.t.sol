// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CenterSessionGuard, PackedUserOperation} from "../contracts/CenterSessionGuard.sol";

interface StackVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function projectRoot() external view returns (string memory);
    function etch(address target, bytes calldata code) external;
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

interface StackEntryPoint {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata op) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable receiver, uint256 amount) external;
}

interface StackSafe {
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

interface StackFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 salt)
        external
        returns (address);
}

interface StackLaunchpad {
    function addSafe7579(address adapter, ModuleInit[] calldata modules, address[] calldata attesters, uint8 threshold)
        external;
}

interface StackSessions {
    function onInstall(bytes calldata data) external;
    function getPermissionId(SessionData calldata session) external pure returns (bytes32);
    function isPermissionEnabled(bytes32 permissionId, address account) external view returns (bool);
    function removeSession(bytes32 permissionId) external;
    function revokeEnableSignature(bytes32 permissionId) external;
    function getNonce(bytes32 permissionId, address account) external view returns (uint256);
}

interface StackPimlicoPaymaster {
    function deposit() external payable;
    function withdrawTo(address payable receiver, uint256 amount) external;
    function getHash(uint8 mode, PackedUserOperation calldata op) external view returns (bytes32);
}

/// @dev V6 pay ABI and caller/value observation fixture; not a production terminal deployment.
contract StackV6PayFixture {
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

contract FullStackTest {
    StackVm private constant vm = StackVm(address(uint160(uint256(keccak256("hevm cheat code")))));
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
    uint256 private constant OWNER_KEY = 0x11112345;
    uint256 private constant BOT_KEY = 0x22223456;
    uint256 private constant PAYMASTER_KEY = 0x33334567;
    address private constant RECIPIENT = address(0xA123);
    address payable private constant BUNDLER = payable(address(0xB456));
    StackEntryPoint private entryPoint = StackEntryPoint(EP);
    StackSafe private safe;
    StackPimlicoPaymaster private sponsor;
    StackV6PayFixture private terminal;
    CenterSessionGuard private guard;
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
        guard = new CenterSessionGuard();
        string memory sponsorJson =
            vm.readFile(string.concat(vm.projectRoot(), "/artifacts/PimlicoSingletonPaymasterV7.json"));
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(PAYMASTER_KEY);
        bytes memory sponsorCreation =
            abi.encodePacked(vm.parseJsonBytes(sponsorJson, ".bytecode"), abi.encode(EP, address(this), signers));
        address sponsorAddress;
        assembly { sponsorAddress := create(0, add(sponsorCreation, 32), mload(sponsorCreation)) }
        require(
            sponsorAddress.codehash == 0x1cd962f550282d1e4eadd0db10a956db2338c40f69c8b07cb434486275e1c11a,
            "paymaster runtime mismatch"
        );
        sponsor = StackPimlicoPaymaster(sponsorAddress);
        terminal = new StackV6PayFixture();
        ModuleInit[] memory modules = new ModuleInit[](1);
        modules[0] = ModuleInit(SMART, "", 1);
        address[] memory owners = new address[](1);
        owners[0] = vm.addr(OWNER_KEY);
        bytes memory initialize = abi.encodeCall(
            StackSafe.setup,
            (
                owners,
                1,
                LAUNCH,
                abi.encodeCall(StackLaunchpad.addSafe7579, (ADAPTER, modules, new address[](0), 0)),
                ADAPTER,
                address(0),
                0,
                address(0)
            )
        );
        safe = StackSafe(StackFactory(FACTORY).createProxyWithNonce(SINGLETON, initialize, 4242));
        require(safe.isModuleEnabled(ADAPTER), "adapter module missing");
        vm.deal(address(safe), 5 ether);
        sponsor.deposit{value: 10 ether}();
        _install();
    }

    function _etch(string memory name, address target, bool patched) private {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/artifacts/", name, ".json"));
        vm.etch(target, vm.parseJsonBytes(json, patched ? ".deployedRuntimeBytecode" : ".deployedBytecode"));
    }

    function _equal(uint64 offset, bytes32 value) private pure returns (Rule memory) {
        return Rule(0, offset, false, value, Usage(0, 0));
    }

    function _install() private {
        SessionData[] memory sessions = new SessionData[](1);
        SessionData memory s;
        s.sessionValidator = OWNABLE;
        address[] memory bots = new address[](1);
        bots[0] = vm.addr(BOT_KEY);
        s.sessionValidatorInitData = abi.encode(uint256(1), bots);
        s.salt = keccak256("full-stack-generation-1");
        validUntil = uint48(block.timestamp + 7 days);
        s.userOpPolicies = new PolicyData[](3);
        s.userOpPolicies[0] = PolicyData(TIME, abi.encodePacked(validUntil, uint48(block.timestamp)));
        s.userOpPolicies[1] = PolicyData(
            address(guard),
            abi.encode(
                CenterSessionGuard.Config(
                    address(sponsor),
                    address(sponsor).codehash,
                    5_000_000,
                    2 gwei,
                    1 gwei,
                    10_000_000,
                    0.1 ether,
                    2,
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
        permissionId = StackSessions(SMART).getPermissionId(s);
        configId = keccak256(abi.encodePacked(address(safe), permissionId));
        _ownerCall(
            SMART,
            0,
            abi.encodeCall(StackSessions.onInstall, (abi.encodePacked(bytes1(0x02), abi.encode(sessions)))),
            OWNER_KEY
        );
        require(
            StackSessions(SMART).isPermissionEnabled(permissionId, address(safe)), "owner session activation failed"
        );
    }

    function _ownerCall(address target, uint256 amount, bytes memory data, uint256 key) private returns (bool) {
        bytes32 digest = safe.getTransactionHash(target, amount, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return safe.execTransaction(
            target, amount, data, 0, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v)
        );
    }

    function _operation(uint256 amount) private view returns (PackedUserOperation memory op) {
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
            address(sponsor), uint128(100_000), uint128(100_000), bytes1(0), validUntil, uint48(0), new bytes(65)
        );
        bytes32 sponsorDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", sponsor.getHash(0, op)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYMASTER_KEY, sponsorDigest);
        op.paymasterAndData = abi.encodePacked(
            address(sponsor), uint128(100_000), uint128(100_000), bytes1(0), validUntil, uint48(0), r, s, v
        );
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
        entryPoint.handleOps(ops, BUNDLER);
    }

    function _rejected(PackedUserOperation memory op) private {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _sign(op, BOT_KEY);
        (bool ok,) = EP.call(abi.encodeCall(entryPoint.handleOps, (ops, BUNDLER)));
        require(!ok, "forbidden operation executed");
    }

    function _callsUsed() private view returns (uint128 calls) {
        (,,, calls) = guard.getConfig(configId, SMART, address(safe));
    }

    function testFullFundedPaymentAndReceiptUseSafePayerAndSponsorGas() public {
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
        StackVm.Log[] memory logs = vm.getRecordedLogs();
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
    }

    function testBudgetAndCallCapsAreEnforcedWithoutBackend() public {
        _submit(_operation(0.6 ether));
        _rejected(_operation(0.5 ether));
        _submit(_operation(0.4 ether));
        _rejected(_operation(1));
        require(terminal.paid() == 1 ether && _callsUsed() == 2, "budget accounting failed");
    }

    function testMissingSponsorAndHugeFeeCannotPrefundNativePrincipal() public {
        PackedUserOperation memory op = _operation(0.1 ether);
        op.paymasterAndData = "";
        _rejected(op);
        op = _operation(0.1 ether);
        op.gasFees = bytes32(uint256(type(uint128).max));
        _rejected(op);
        op = _operation(0.1 ether);
        op.paymasterAndData[52] = bytes1(0x02);
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
        (bool ok,) = EP.call(abi.encodeCall(entryPoint.handleOps, (ops, BUNDLER)));
        require(!ok, "wrong bot signer accepted");
        vm.warp(validUntil + 1);
        _rejected(_operation(0.1 ether));
        vm.warp(validUntil - 1);
        uint256 nonce = StackSessions(SMART).getNonce(permissionId, address(safe));
        require(
            _ownerCall(SMART, 0, abi.encodeCall(StackSessions.removeSession, (permissionId)), OWNER_KEY),
            "owner revoke failed"
        );
        require(
            _ownerCall(SMART, 0, abi.encodeCall(StackSessions.revokeEnableSignature, (permissionId)), OWNER_KEY),
            "enable nonce revoke failed"
        );
        require(StackSessions(SMART).getNonce(permissionId, address(safe)) == nonce + 1, "enable nonce unchanged");
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
        _rejected(op);
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

    function testRevertedActionRetainsValidationCountersAndSponsorDepletionFailsClosed() public {
        terminal.setReject(true);
        uint256 deposit = entryPoint.balanceOf(address(sponsor));
        vm.recordLogs();
        bytes32 hash = _submit(_operation(0.1 ether));
        bool observedFailure;
        StackVm.Log[] memory logs = vm.getRecordedLogs();
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
        sponsor.withdrawTo(payable(address(this)), entryPoint.balanceOf(address(sponsor)));
        terminal.setReject(false);
        _rejected(_operation(0.1 ether));
        require(
            _callsUsed() == 1 && entryPoint.balanceOf(address(safe)) == 0 && address(safe).balance == 5 ether,
            "depleted sponsor fell back to account"
        );
    }
    receive() external payable {}
}
