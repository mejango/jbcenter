// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {
    PasskeyVm,
    PasskeyUserOp,
    PasskeyModuleInit,
    PasskeyFactory,
    PasskeySafe,
    PasskeySafeFactory,
    PasskeyLaunchpad,
    PasskeyAdapter,
    PasskeyEntryPoint
} from "./Interfaces.sol";

interface ProxyCode {
    function proxyCreationCode() external view returns (bytes memory);
}

contract BootstrapAction {
    uint256 public calls;
    bool public reject;

    function setReject(bool value) external {
        reject = value;
    }

    function record() external {
        require(!reject, "execution rejected");
        calls++;
    }
}

contract PasskeyBootstrapTest {
    PasskeyVm private constant vm = PasskeyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address private constant SMART = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address private constant ADAPTER = 0x7579f2AD53b01c3D8779Fe17928e0D48885B0003;
    address private constant LAUNCH = 0x75798463024Bda64D83c94A64Bc7D7eaB41300eF;
    address private constant SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address private constant FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address private constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;
    uint256 private constant X = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296;
    uint256 private constant Y = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5;

    address private signer;
    address private verifier;
    PasskeyFactory private signerFactory;
    BootstrapAction private action;
    event log_named_uint(string key, uint256 value);

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1_800_000_000);
        vm.fee(1 gwei);
        vm.deal(address(this), 100 ether);
        _etch("EntryPoint", EP, true);
        _etch("SenderCreator", 0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C, false);
        _etch("Safe7579", ADAPTER, true);
        _etch("SmartSession", SMART, false);
        _etch("Safe7579Launchpad", LAUNCH, true);
        _etch("Safe7579DCUtil", 0x3fB7a8Bee59D8C5b2F1Cf6CE93e5E694Cb233B57, false);
        _etch("SafeL2", SINGLETON, false);
        _etch("SafeProxyFactory", FACTORY, false);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/artifacts/MultiSend.json"));
        vm.etch(MULTISEND, vm.parseJsonBytes(json, ".deployedRuntimeBytecode"));
        require(
            MULTISEND.codehash == 0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77,
            "MultiSend runtime differs"
        );
        verifier = _deploy("FCLP256Verifier");
        signerFactory = PasskeyFactory(_deploy("SafeWebAuthnSignerFactory"));
        signer = signerFactory.getSigner(X, Y, uint176(uint160(verifier)));
        require(signer.code.length == 0, "signer must start undeployed");
        action = new BootstrapAction();
    }

    function _etch(string memory name, address target, bool patched) private {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../../artifacts/", name, ".json"));
        vm.etch(target, vm.parseJsonBytes(json, patched ? ".deployedRuntimeBytecode" : ".deployedBytecode"));
    }

    function _deploy(string memory name) private returns (address deployed) {
        bytes memory code =
            vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), "/../artifacts/", name, ".json")), ".bytecode");
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "deployment failed");
    }

    function _entry(uint8 operation, address target, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(operation, target, uint256(0), data.length, data);
    }

    function _initializer(bool atomic, address backup, bool brokenLaunch) private view returns (bytes memory) {
        PasskeyModuleInit[] memory modules = new PasskeyModuleInit[](1);
        modules[0] = PasskeyModuleInit(SMART, "", 1);
        bytes memory launch = abi.encodeCall(PasskeyLaunchpad.addSafe7579, (ADAPTER, modules, new address[](0), 0));
        if (brokenLaunch) launch = hex"deadbeef";
        address target = LAUNCH;
        bytes memory data = launch;
        if (atomic) {
            bytes memory create = abi.encodeCall(PasskeyFactory.createSigner, (X, Y, uint176(uint160(verifier))));
            bytes memory entries = abi.encodePacked(
                _entry(0, address(signerFactory), create), _entry(1, LAUNCH, launch)
            );
            target = MULTISEND;
            data = abi.encodeWithSignature("multiSend(bytes)", entries);
        }
        address[] memory owners = new address[](2);
        owners[0] = signer;
        owners[1] = backup;
        return abi.encodeCall(PasskeySafe.setup, (owners, 1, target, data, ADAPTER, address(0), 0, address(0)));
    }

    function _predict(bytes memory initializer, uint256 saltNonce) private view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        bytes memory creation = abi.encodePacked(ProxyCode(FACTORY).proxyCreationCode(), uint256(uint160(SINGLETON)));
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", FACTORY, salt, keccak256(creation))))));
    }

    function _prepare(bool atomic, address backup, bool brokenLaunch) private view returns (PasskeyUserOp memory op) {
        bytes memory initializer = _initializer(atomic, backup, brokenLaunch);
        op.sender = _predict(initializer, 8181);
        op.initCode = abi.encodePacked(
            FACTORY, abi.encodeCall(PasskeySafeFactory.createProxyWithNonce, (SINGLETON, initializer, 8181))
        );
        op.callData = abi.encodeWithSignature(
            "execute(bytes32,bytes)",
            bytes32(0),
            abi.encodePacked(address(action), uint256(0), abi.encodeCall(BootstrapAction.record, ()))
        );
        op.accountGasLimits = bytes32((uint256(2_000_000) << 128) | uint256(200_000));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
        op.signature = abi.encodePacked(uint48(block.timestamp), uint48(block.timestamp + 300));
    }

    function _sign(PasskeyUserOp memory op, uint8 flags, uint256 key) private view returns (PasskeyUserOp memory) {
        (bytes memory data,,,) = PasskeyAdapter(ADAPTER).getSafeOp(op, EP);
        bytes32 challenge = keccak256(data);
        bytes memory auth = abi.encodePacked(sha256("wallet.juicebox.center"), flags, uint32(0));
        bytes memory encoded = bytes(vm.toBase64URL(abi.encodePacked(challenge)));
        require(encoded.length == 44 && encoded[43] == "=", "base64 fixture changed");
        assembly { mstore(encoded, 43) }
        string memory fields = '"origin":"https://wallet.juicebox.center","crossOrigin":false';
        bytes memory client = abi.encodePacked('{"type":"webauthn.get","challenge":"', encoded, '",', fields, "}");
        (bytes32 r, bytes32 s) = vm.signP256(key, sha256(abi.encodePacked(auth, sha256(client))));
        bytes memory assertion = abi.encode(auth, fields, uint256(r), uint256(s));
        op.signature =
            abi.encodePacked(op.signature, uint256(uint160(signer)), uint256(65), uint8(0), assertion.length, assertion);
        return op;
    }

    function _fund(address sender) private {
        PasskeyEntryPoint(EP).depositTo{value: 2 ether}(sender);
    }

    function _submit(PasskeyUserOp memory op) private returns (bool ok, bytes memory result) {
        PasskeyUserOp[] memory ops = new PasskeyUserOp[](1);
        ops[0] = op;
        return EP.call(abi.encodeCall(PasskeyEntryPoint.handleOps, (ops, payable(address(0xB456)))));
    }

    function _receipt(bytes32 expected, bool expectedSuccess) private returns (uint256 gasUsed) {
        PasskeyVm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == EP && logs[i].topics.length == 4
                    && logs[i].topics[0]
                        == keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
            ) {
                require(logs[i].topics[1] == expected, "wrong op receipt");
                (, bool success,, uint256 used) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                require(success == expectedSuccess, "wrong execution outcome");
                gasUsed = used;
                found = true;
            }
        }
        require(found && gasUsed > 0, "receipt missing");
    }

    function testExistingInitializerCannotValidateUndeployedPasskey() public {
        PasskeyUserOp memory op = _sign(_prepare(false, vm.addr(0xC0FFEE), false), 5, 1);
        _fund(op.sender);
        (bool ok, bytes memory failure) = _submit(op);
        require(!ok, "undeployed signer unexpectedly validated");
        require(
            keccak256(failure)
                == keccak256(abi.encodeWithSignature("FailedOp(uint256,string)", uint256(0), "AA24 signature error")),
            "baseline failed for another reason"
        );
        require(op.sender.code.length == 0 && signer.code.length == 0, "failed validation retained deployments");
    }

    function testAtomicMultiSendCreatesSignerAndSafeBeforeFirstValidation() public {
        PasskeyUserOp memory op = _sign(_prepare(true, vm.addr(0xC0FFEE), false), 5, 1);
        _fund(op.sender);
        require(op.sender.code.length == 0 && signer.code.length == 0, "not counterfactual");
        vm.recordLogs();
        (bool ok,) = _submit(op);
        require(ok, "atomic bootstrap failed");
        emit log_named_uint("bootstrapActualGasUsed", _receipt(PasskeyEntryPoint(EP).getUserOpHash(op), true));
        emit log_named_uint("bootstrapInitCodeBytes", op.initCode.length);
        emit log_named_uint("bootstrapPackedUserOperationBytes", abi.encode(op).length);
        require(op.sender.code.length > 0 && signer.code.length > 0, "atomic deployment missing");
        require(
            PasskeySafe(op.sender).isOwner(signer) && PasskeySafe(op.sender).isOwner(vm.addr(0xC0FFEE))
                && PasskeySafe(op.sender).getThreshold() == 1,
            "unexpected authority"
        );
        require(
            action.calls() == 1 && PasskeyEntryPoint(EP).getNonce(op.sender, 0) == 1, "first operation effect missing"
        );
        (ok,) = _submit(op);
        require(!ok && action.calls() == 1, "bootstrap replay accepted");
    }

    function testWrongKeyRollsBackBothAtomicDeployments() public {
        PasskeyUserOp memory op = _sign(_prepare(true, vm.addr(0xC0FFEE), false), 5, 2);
        _fund(op.sender);
        (bool ok,) = _submit(op);
        require(!ok, "wrong key accepted");
        require(
            op.sender.code.length == 0 && signer.code.length == 0 && action.calls() == 0, "failed validation not atomic"
        );
    }

    function testMissingUVRollsBackBothAtomicDeployments() public {
        PasskeyUserOp memory op = _sign(_prepare(true, vm.addr(0xC0FFEE), false), 1, 1);
        _fund(op.sender);
        (bool ok,) = _submit(op);
        require(!ok, "missing UV accepted");
        require(op.sender.code.length == 0 && signer.code.length == 0, "failed validation not atomic");
    }

    function testBrokenLaunchRollsBackNewSigner() public {
        PasskeyUserOp memory op = _sign(_prepare(true, vm.addr(0xC0FFEE), true), 5, 1);
        _fund(op.sender);
        (bool ok,) = _submit(op);
        require(!ok, "invalid launch accepted");
        require(op.sender.code.length == 0 && signer.code.length == 0, "failed launch retained signer");
    }

    function testPrecreatedSignerRemainsIdempotent() public {
        PasskeyUserOp memory op = _sign(_prepare(true, vm.addr(0xC0FFEE), false), 5, 1);
        _fund(op.sender);
        require(signerFactory.createSigner(X, Y, uint176(uint160(verifier))) == signer, "unexpected signer");
        (bool ok,) = _submit(op);
        require(ok && action.calls() == 1, "precreated signer broke exact approval");
    }

    function testDifferentBackupCannotReuseOriginalInitializationApproval() public {
        PasskeyUserOp memory approved = _sign(_prepare(true, vm.addr(0xC0FFEE), false), 5, 1);
        PasskeyUserOp memory altered = _prepare(true, vm.addr(0xBAD), false);
        altered.signature = approved.signature;
        _fund(altered.sender);
        (bool ok,) = _submit(altered);
        require(!ok, "altered recovery owner accepted old passkey approval");
        require(altered.sender.code.length == 0 && signer.code.length == 0, "altered deployment retained");
    }

    function testExecutionFailureLeavesValidatedDeploymentForReconciliation() public {
        PasskeyUserOp memory op = _sign(_prepare(true, vm.addr(0xC0FFEE), false), 5, 1);
        _fund(op.sender);
        action.setReject(true);
        vm.recordLogs();
        (bool ok,) = _submit(op);
        require(ok, "execution failure reverted whole handleOps");
        _receipt(PasskeyEntryPoint(EP).getUserOpHash(op), false);
        require(
            op.sender.code.length > 0 && signer.code.length > 0 && action.calls() == 0,
            "journal deployment boundary differs"
        );
        require(PasskeyEntryPoint(EP).getNonce(op.sender, 0) == 1, "failed execution did not consume nonce");
    }

    function testDirectFactoryTransactionAtomicallyCreatesBothWithoutEntryPoint() public {
        bytes memory init = _initializer(true, vm.addr(0xC0FFEE), false);
        address expected = _predict(init, 8181);
        vm.etch(EP, "");
        uint256 before = gasleft();
        address deployed = PasskeySafeFactory(FACTORY).createProxyWithNonce(SINGLETON, init, 8181);
        emit log_named_uint("directFactoryExecutionGas", before - gasleft());
        require(
            deployed == expected && deployed.code.length > 0 && signer.code.length > 0,
            "direct factory bootstrap failed"
        );
        require(
            PasskeySafe(deployed).isOwner(signer) && PasskeySafe(deployed).getThreshold() == 1,
            "direct authority differs"
        );
    }

    function testCanonical500kVerificationBudgetRejectsAtomicBootstrap() public {
        PasskeyUserOp memory op = _prepare(true, vm.addr(0xC0FFEE), false);
        op.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(200_000));
        op = _sign(op, 5, 1);
        _fund(op.sender);
        (bool ok,) = _submit(op);
        require(!ok, "atomic bootstrap fit canonical500k limit; reassess measured blocker");
        require(op.sender.code.length == 0 && signer.code.length == 0, "budget rejection retained deployments");
    }
    receive() external payable {}
}
