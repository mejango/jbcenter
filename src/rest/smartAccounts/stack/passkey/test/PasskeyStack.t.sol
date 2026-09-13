// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface PasskeyVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
    function projectRoot() external view returns (string memory);
    function etch(address target, bytes calldata code) external;
    function deal(address target, uint256 amount) external;
    function addr(uint256 key) external pure returns (address);
    function sign(uint256 key, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function signP256(uint256 key, bytes32 digest) external pure returns (bytes32, bytes32);
    function toBase64URL(bytes calldata data) external pure returns (string memory);
    function warp(uint256 timestamp) external;
    function chainId(uint256 chain) external;
    function fee(uint256 basefee) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

struct PasskeyUserOp {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

struct PasskeyModuleInit {
    address module;
    bytes initData;
    uint256 moduleType;
}

interface PasskeyFactory {
    function createSigner(uint256 x, uint256 y, uint176 verifiers) external returns (address);
    function getSigner(uint256 x, uint256 y, uint176 verifiers) external view returns (address);
    function SINGLETON() external view returns (address);
}

interface PasskeySafe {
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
    function domainSeparator() external view returns (bytes32);
    function nonce() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function swapOwner(address previousOwner, address oldOwner, address newOwner) external;
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
}

interface PasskeySafeFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 salt)
        external
        returns (address);
}

interface PasskeyLaunchpad {
    function addSafe7579(
        address adapter,
        PasskeyModuleInit[] calldata modules,
        address[] calldata attesters,
        uint8 threshold
    ) external;
}

interface PasskeyAdapter {
    function getSafeOp(PasskeyUserOp calldata op, address entryPoint)
        external
        view
        returns (bytes memory operationData, uint48 validAfter, uint48 validUntil, bytes memory signatures);
}

interface PasskeyEntryPoint {
    function handleOps(PasskeyUserOp[] calldata ops, address payable beneficiary) external;
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getUserOpHash(PasskeyUserOp calldata op) external view returns (bytes32);
    function depositTo(address account) external payable;
}

/// @dev Real cryptographic compatibility experiment. Only the browser authenticator is simulated.
/// The unmodified upstream FCL, signer, Safe, adapter and EntryPoint all execute their actual code.
contract PasskeyStackTest {
    PasskeyVm private constant vm = PasskeyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address private constant SMART = 0x00000000002B0eCfbD0496EE71e01257dA0E37DE;
    address private constant ADAPTER = 0x7579f2AD53b01c3D8779Fe17928e0D48885B0003;
    address private constant LAUNCH = 0x75798463024Bda64D83c94A64Bc7D7eaB41300eF;
    address private constant SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address private constant FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address private constant RECIPIENT = address(0xBEEF);
    uint256 private constant BACKUP_KEY = 0xC0FFEE;
    uint256 private constant P256_X = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296;
    uint256 private constant P256_Y = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5;
    string private constant CLIENT_FIELDS = '"origin":"https://wallet.juicebox.center","crossOrigin":false';
    bytes4 private constant MAGIC = 0x1626ba7e;
    bytes4 private constant LEGACY_MAGIC = 0x20c13b0b;
    PasskeyFactory private signerFactory;
    address private verifier;
    address private signer;
    PasskeySafe private safe;
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
        verifier = _deploy("FCLP256Verifier");
        signerFactory = PasskeyFactory(_deploy("SafeWebAuthnSignerFactory"));
        signer = signerFactory.createSigner(P256_X, P256_Y, uint176(uint160(verifier)));
        address[] memory owners = new address[](2);
        owners[0] = signer;
        owners[1] = vm.addr(BACKUP_KEY);
        safe = _createSafe(owners, 1, 4242);
        vm.deal(address(safe), 5 ether);
        PasskeyEntryPoint(EP).depositTo{value: 2 ether}(address(safe));
    }

    function _etch(string memory name, address target, bool patched) private {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../artifacts/", name, ".json"));
        vm.etch(target, vm.parseJsonBytes(json, patched ? ".deployedRuntimeBytecode" : ".deployedBytecode"));
    }

    function _deploy(string memory name) private returns (address deployed) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/artifacts/", name, ".json"));
        bytes memory creation = vm.parseJsonBytes(json, ".bytecode");
        assembly { deployed := create(0, add(creation, 32), mload(creation)) }
        require(deployed != address(0), "upstream contract deployment failed");
    }

    function _createSafe(address[] memory owners, uint256 threshold, uint256 salt) private returns (PasskeySafe) {
        PasskeyModuleInit[] memory modules = new PasskeyModuleInit[](1);
        modules[0] = PasskeyModuleInit(SMART, "", 1);
        bytes memory initializer = abi.encodeCall(
            PasskeySafe.setup,
            (
                owners,
                threshold,
                LAUNCH,
                abi.encodeCall(PasskeyLaunchpad.addSafe7579, (ADAPTER, modules, new address[](0), 0)),
                ADAPTER,
                address(0),
                0,
                address(0)
            )
        );
        return PasskeySafe(PasskeySafeFactory(FACTORY).createProxyWithNonce(SINGLETON, initializer, salt));
    }

    function _assertion(bytes32 challenge, uint8 flags, uint256 key) private pure returns (bytes memory) {
        return _assertionWithFields(challenge, flags, key, CLIENT_FIELDS);
    }

    function _assertionWithFields(bytes32 challenge, uint8 flags, uint256 key, string memory fields)
        private
        pure
        returns (bytes memory)
    {
        bytes memory authenticatorData = abi.encodePacked(sha256("wallet.juicebox.center"), flags, uint32(0));
        bytes memory encodedChallenge = bytes(vm.toBase64URL(abi.encodePacked(challenge)));
        require(encodedChallenge.length == 44 && encodedChallenge[43] == "=", "unexpected fixture base64 output");
        // WebAuthn challenges use unpadded base64url. Foundry's helper includes the final '='.
        assembly { mstore(encodedChallenge, 43) }
        bytes memory clientData =
            abi.encodePacked('{"type":"webauthn.get","challenge":"', encodedChallenge, '",', fields, "}");
        (bytes32 r, bytes32 s) = vm.signP256(key, sha256(abi.encodePacked(authenticatorData, sha256(clientData))));
        return abi.encode(authenticatorData, fields, uint256(r), uint256(s));
    }

    function _ownerSignature(bytes memory assertion) private view returns (bytes memory) {
        return abi.encodePacked(uint256(uint160(signer)), uint256(65), uint8(0), assertion.length, assertion);
    }

    function _safeMessage(bytes32 hash) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                hex"1901",
                safe.domainSeparator(),
                keccak256(abi.encode(keccak256("SafeMessage(bytes message)"), keccak256(abi.encode(hash))))
            )
        );
    }

    function _isValid(address target, bytes4 selector, bytes memory data, bytes memory signature)
        private
        view
        returns (bool)
    {
        bytes memory callData = selector == MAGIC
            ? abi.encodeWithSelector(selector, abi.decode(data, (bytes32)), signature)
            : abi.encodeWithSelector(selector, data, signature);
        (bool ok, bytes memory result) = target.staticcall(callData);
        return ok && result.length == 32 && abi.decode(result, (bytes4)) == selector;
    }

    function _validLogin(bytes32 hash, bytes memory signature) private view returns (bool) {
        return _isValid(address(safe), MAGIC, abi.encode(hash), abi.encodePacked(address(0), signature));
    }

    function _unsignedOperation() private view returns (PasskeyUserOp memory op) {
        op.sender = address(safe);
        op.nonce = PasskeyEntryPoint(EP).getNonce(address(safe), 0);
        op.callData = abi.encodeWithSignature(
            "execute(bytes32,bytes)", bytes32(0), abi.encodePacked(RECIPIENT, uint256(0.1 ether), bytes(""))
        );
        op.accountGasLimits = bytes32((uint256(800_000) << 128) | uint256(200_000));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
        op.signature = abi.encodePacked(uint48(block.timestamp), uint48(block.timestamp + 300));
    }

    function _operationDigest(PasskeyUserOp memory op) private view returns (bytes32) {
        (bytes memory data,,,) = PasskeyAdapter(ADAPTER).getSafeOp(op, EP);
        return keccak256(data);
    }

    function _operation() private view returns (PasskeyUserOp memory op) {
        op = _unsignedOperation();
        op.signature = abi.encodePacked(op.signature, _ownerSignature(_assertion(_operationDigest(op), 5, 1)));
    }

    function _submit(PasskeyUserOp memory op) private returns (bool ok) {
        PasskeyUserOp[] memory operations = new PasskeyUserOp[](1);
        operations[0] = op;
        (ok,) = EP.call(abi.encodeCall(PasskeyEntryPoint.handleOps, (operations, payable(address(0xB456)))));
    }

    function _backupTransaction(address target, uint256 amount, bytes memory data) private view returns (bytes memory) {
        bytes32 digest = safe.getTransactionHash(target, amount, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BACKUP_KEY, digest);
        return abi.encodeCall(
            PasskeySafe.execTransaction,
            (target, amount, data, 0, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v))
        );
    }

    function testFactoryPredictionAndRepeatCreationMatchImmutableCredential() public {
        require(signer == signerFactory.getSigner(P256_X, P256_Y, uint176(uint160(verifier))), "address differs");
        require(
            signerFactory.createSigner(P256_X, P256_Y, uint176(uint160(verifier))) == signer, "non-idempotent create"
        );
        require(signer.code.length > 0 && signerFactory.SINGLETON().code.length > 0, "missing real signer code");
        require(safe.getThreshold() == 1 && safe.isOwner(signer) && safe.isOwner(vm.addr(BACKUP_KEY)), "wrong owners");
    }

    function testSignerSupportsBothRealERC1271Selectors() public {
        bytes memory data = "Center exact reviewed challenge";
        bytes memory assertion = _assertion(keccak256(data), 5, 1);
        require(_isValid(signer, MAGIC, abi.encode(keccak256(data)), assertion), "modern selector invalid");
        require(_isValid(signer, LEGACY_MAGIC, data, assertion), "legacy Safe owner selector invalid");
        require(!_isValid(signer, MAGIC, abi.encode(keccak256("other")), assertion), "wrong challenge accepted");
    }

    function testSafeMessageAuthenticatesStableSafePrincipal() public {
        bytes32 hash = keccak256("Center login challenge with purpose and nonce");
        bytes memory signature = _ownerSignature(_assertion(_safeMessage(hash), 5, 1));
        uint256 gasStart = gasleft();
        require(_validLogin(hash, signature), "SafeMessage owner authentication failed");
        emit log_named_uint("safeMessageVerificationGas", gasStart - gasleft());
        emit log_named_uint("safeMessageSignatureBytes", signature.length + 20);
        require(!_validLogin(keccak256("different challenge"), signature), "challenge substitution accepted");
    }

    function testUserOperationExecutesThroughActualEntryPointAndSafe() public {
        PasskeyUserOp memory op = _operation();
        bytes32 expectedHash = PasskeyEntryPoint(EP).getUserOpHash(op);
        vm.recordLogs();
        uint256 gasStart = gasleft();
        require(_submit(op), "EntryPoint rejected passkey operation");
        emit log_named_uint("entryPointHandleOpsGas", gasStart - gasleft());
        emit log_named_uint("userOperationSignatureBytes", op.signature.length);
        emit log_named_uint("userOperationCalldataBytes", abi.encode(op).length);
        require(RECIPIENT.balance == 0.1 ether, "canonical payment effect missing");
        bool observed;
        PasskeyVm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == EP && logs[i].topics.length == 4
                    && logs[i].topics[0]
                        == keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
            ) {
                (, bool success, uint256 gasCost, uint256 gasUsed) =
                    abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                require(logs[i].topics[1] == expectedHash && success && gasCost > 0, "receipt differs");
                emit log_named_uint("userOperationActualGasUsed", gasUsed);
                observed = true;
            }
        }
        require(observed, "canonical EntryPoint receipt missing");
        require(!_submit(op) && RECIPIENT.balance == 0.1 ether, "operation replay accepted");
    }

    function testLoginSignatureCannotAuthorizeUserOperation() public {
        PasskeyUserOp memory op = _unsignedOperation();
        op.signature =
            abi.encodePacked(op.signature, _ownerSignature(_assertion(_safeMessage(_operationDigest(op)), 5, 1)));
        require(!_submit(op), "SafeMessage replayed as SafeOp");
    }

    function testUserOperationSignatureCannotAuthenticateLogin() public {
        PasskeyUserOp memory op = _unsignedOperation();
        bytes32 hash = _operationDigest(op);
        require(!_validLogin(hash, _ownerSignature(_assertion(hash, 5, 1))), "SafeOp replayed as SafeMessage");
    }

    function testWrongCredentialAndMissingUVRejected() public {
        bytes32 hash = keccak256("challenge");
        require(!_isValid(signer, MAGIC, abi.encode(hash), _assertion(hash, 5, 2)), "wrong key accepted");
        require(!_isValid(signer, MAGIC, abi.encode(hash), _assertion(hash, 1, 1)), "missing UV accepted");
        PasskeyUserOp memory op = _unsignedOperation();
        op.signature = abi.encodePacked(op.signature, _ownerSignature(_assertion(_operationDigest(op), 1, 1)));
        require(!_submit(op), "EntryPoint accepted missing UV");
    }

    function testChangedPaymentAndValidityRejected() public {
        PasskeyUserOp memory op = _operation();
        op.callData = abi.encodeWithSignature(
            "execute(bytes32,bytes)", bytes32(0), abi.encodePacked(RECIPIENT, uint256(1 ether), bytes(""))
        );
        require(!_submit(op), "changed payment accepted");
        op = _operation();
        op.signature[0] = bytes1(uint8(op.signature[0]) ^ 1);
        require(!_submit(op), "changed validity accepted");
    }

    function testExpiredOperationRejected() public {
        PasskeyUserOp memory op = _operation();
        vm.warp(block.timestamp + 301);
        require(!_submit(op), "expired operation accepted");
    }

    function testCrossChainAndCrossSafeReplayRejected() public {
        bytes32 hash = keccak256("challenge");
        bytes memory signature = _ownerSignature(_assertion(_safeMessage(hash), 5, 1));
        vm.chainId(1);
        require(!_validLogin(hash, signature), "cross-chain replay accepted");
        vm.chainId(8453);
        address[] memory owners = safe.getOwners();
        safe = _createSafe(owners, 1, 4243);
        require(!_validLogin(hash, signature), "cross-Safe replay accepted");
    }

    function testMalformedOwnerDynamicOffsetRejected() public {
        bytes32 hash = keccak256("challenge");
        bytes memory assertion = _assertion(_safeMessage(hash), 5, 1);
        bytes memory signature =
            abi.encodePacked(uint256(uint160(signer)), uint256(64), uint8(0), assertion.length, assertion);
        require(!_validLogin(hash, signature), "pointer into static signature accepted");
        signature = abi.encodePacked(uint256(uint160(signer)), uint256(1 << 128), uint8(0), assertion.length, assertion);
        require(!_validLogin(hash, signature), "out of bounds pointer accepted");
    }

    function testOversizedAssertionTrailingDataRejected() public {
        bytes32 hash = keccak256("challenge");
        bytes memory assertion = abi.encodePacked(_assertion(hash, 5, 1), bytes32(0));
        require(!_isValid(signer, MAGIC, abi.encode(hash), assertion), "assertion padding attack accepted");
    }

    function testDuplicateOwnersCannotBeInitialized() public {
        address[] memory owners = new address[](2);
        owners[0] = signer;
        owners[1] = signer;
        bytes memory initializer =
            abi.encodeCall(PasskeySafe.setup, (owners, 1, address(0), bytes(""), ADAPTER, address(0), 0, address(0)));
        (bool ok,) =
            FACTORY.call(abi.encodeCall(PasskeySafeFactory.createProxyWithNonce, (SINGLETON, initializer, 4444)));
        require(!ok, "duplicate owners accepted");
    }

    function testIndependentBackupCanWithdrawWithEntryPointAndAdapterUnavailable() public {
        bytes memory transaction = _backupTransaction(RECIPIENT, 5 ether, "");
        vm.etch(EP, "");
        vm.etch(ADAPTER, "");
        vm.etch(verifier, "");
        vm.etch(signer, "");
        (bool ok, bytes memory result) = address(safe).call(transaction);
        require(ok && abi.decode(result, (bool)), "independent direct EOA recovery failed");
        require(RECIPIENT.balance == 5 ether && address(safe).balance == 0, "recovery amount differs");
        (ok,) = address(safe).call(transaction);
        require(!ok, "direct recovery replay accepted");
    }

    function testIndependentBackupRotatesPasskeyWithoutMovingSafeIdentity() public {
        address oldSafe = address(safe);
        bytes32 hash = keccak256("recovery challenge");
        bytes memory oldSignature = _ownerSignature(_assertion(_safeMessage(hash), 5, 1));
        // Another independent P256 credential (scalar 2), fixed standard generator multiplication.
        address replacement = signerFactory.createSigner(
            0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978,
            0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1,
            uint176(uint160(verifier))
        );
        address[] memory owners = safe.getOwners();
        address previous = owners[0] == signer ? address(1) : owners[0];
        bytes memory transaction = _backupTransaction(
            address(safe), 0, abi.encodeCall(PasskeySafe.swapOwner, (previous, signer, replacement))
        );
        vm.etch(EP, "");
        (bool ok, bytes memory result) = address(safe).call(transaction);
        require(ok && abi.decode(result, (bool)), "backup rotation failed");
        require(
            address(safe) == oldSafe && safe.isOwner(replacement) && !safe.isOwner(signer),
            "identity/ownership changed incorrectly"
        );
        require(!_validLogin(hash, oldSignature), "removed credential still authenticates");
        signer = replacement;
        require(
            _validLogin(hash, _ownerSignature(_assertion(_safeMessage(hash), 5, 2))), "replacement cannot authenticate"
        );
    }

    function testUnavailablePrecompileFallsBackToRealFCLVerifier() public {
        uint176 verifiers = (uint176(0x0100) << 160) | uint176(uint160(verifier));
        address fallbackSigner = signerFactory.createSigner(P256_X, P256_Y, verifiers);
        bytes32 hash = keccak256("fallback crypto challenge");
        require(_isValid(fallbackSigner, MAGIC, abi.encode(hash), _assertion(hash, 5, 1)), "real FCL fallback failed");
        require(
            !_isValid(fallbackSigner, MAGIC, abi.encode(hash), _assertion(hash, 5, 2)),
            "FCL fallback accepted wrong key"
        );
    }

    function testDuplicateSignerCannotMeetTwoOwnerThreshold() public {
        safe = _createSafe(safe.getOwners(), 2, 5151);
        bytes32 hash = keccak256("threshold two");
        bytes memory assertion = _assertion(_safeMessage(hash), 5, 1);
        bytes memory staticSignature = abi.encodePacked(uint256(uint160(signer)), uint256(130), uint8(0));
        bytes memory signature = abi.encodePacked(staticSignature, staticSignature, assertion.length, assertion);
        require(!_validLogin(hash, signature), "duplicate contract signature met threshold");
    }

    function testUpstreamAllowsUnusedOuterBytesRequiringCanonicalAdmission() public {
        bytes32 hash = keccak256("canonical admission boundary");
        bytes memory signature = _ownerSignature(_assertion(_safeMessage(hash), 5, 1));
        // Safe intentionally checks only threshold signatures. Center's admission decoder must
        // reject this alias before it becomes an idempotency or estimation input.
        require(
            _validLogin(hash, abi.encodePacked(signature, bytes32(0))),
            "upstream behavior changed; reassess codec boundary"
        );
    }

    function testFuzzRealP256CannotSubstituteChallenge(bytes32 challenge) public {
        bytes memory assertion = _assertion(challenge, 5, 1);
        require(_isValid(signer, MAGIC, abi.encode(challenge), assertion), "real FCL rejected valid signature");
        require(
            !_isValid(signer, MAGIC, abi.encode(bytes32(uint256(challenge) ^ 1)), assertion),
            "challenge bit substitution accepted"
        );
    }

    function _typescriptFixture(string memory name) private view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../../../../../test/fixtures/wallet/", name, ".json"));
    }

    function _verifyTypescriptFixture(string memory name) private returns (uint256 gasUsed, uint256 signatureBytes) {
        string memory json = _typescriptFixture(name);
        uint256 x = abi.decode(vm.parseJsonBytes(json, ".publicKey.x"), (uint256));
        uint256 y = abi.decode(vm.parseJsonBytes(json, ".publicKey.y"), (uint256));
        bytes32 challenge = abi.decode(vm.parseJsonBytes(json, ".challenge"), (bytes32));
        bytes memory assertion = vm.parseJsonBytes(json, ".contractSignature");
        address fixtureSigner = signerFactory.createSigner(x, y, uint176(uint160(verifier)));
        uint256 gasStart = gasleft();
        require(
            _isValid(fixtureSigner, MAGIC, abi.encode(challenge), assertion),
            "TypeScript assertion rejected by unmodified Solidity signer"
        );
        gasUsed = gasStart - gasleft();
        signatureBytes = assertion.length;
        require(
            !_isValid(fixtureSigner, MAGIC, abi.encode(bytes32(uint256(challenge) ^ 1)), assertion),
            "fixture challenge substitution accepted"
        );
    }

    function testExactTypeScriptVerifierOutputExecutesActualSigner() public {
        _verifyTypescriptFixture("passkey-assertion");
    }

    function testMaximumTypeScriptAssertionHasBoundedVerificationGas() public {
        (uint256 gasUsed, uint256 signatureBytes) = _verifyTypescriptFixture("passkey-assertion-max");
        require(signatureBytes == 2240, "WebAuthn maximum size changed; remeasure admission/estimation limits");
        require(gasUsed < 400_000, "maximum WebAuthn assertion exceeds reviewed FCL gas bound");
        emit log_named_uint("maxAssertionVerificationGas", gasUsed);
        emit log_named_uint("maxAssertionSignatureBytes", signatureBytes);
    }

    function testMaximumSizeUserOperationExecutesWithinGasBudget() public {
        string memory json = _typescriptFixture("passkey-assertion-max");
        string memory fields = vm.parseJsonString(json, ".clientDataFields");
        PasskeyUserOp memory op = _unsignedOperation();
        op.signature =
            abi.encodePacked(op.signature, _ownerSignature(_assertionWithFields(_operationDigest(op), 5, 1, fields)));
        require(op.signature.length == 2349, "maximum owner envelope size changed");
        vm.recordLogs();
        require(_submit(op), "maximum WebAuthn UserOperation rejected");
        require(RECIPIENT.balance == 0.1 ether, "maximum operation payment missing");
        PasskeyVm.Log[] memory logs = vm.getRecordedLogs();
        bool observed;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == EP && logs[i].topics.length == 4
                    && logs[i].topics[0]
                        == keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
            ) {
                (, bool success,, uint256 gasUsed) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                require(success && gasUsed > 0 && gasUsed < 800_000, "maximum operation exceeds local FCL gas budget");
                emit log_named_uint("maxUserOperationActualGasUsed", gasUsed);
                emit log_named_uint("maxUserOperationSignatureBytes", op.signature.length);
                observed = true;
            }
        }
        require(observed, "maximum operation receipt missing");
    }

    function testUpstreamDefersOriginAndUPPolicyToTrustedAdmission() public {
        bytes32 hash = keccak256("server policy characterization");
        // The signer enforces UV; Center separately requires UP and its configured origin/RP.
        require(_isValid(signer, MAGIC, abi.encode(hash), _assertion(hash, 4, 1)), "upstream UV-only policy changed");
        bytes memory otherOrigin =
            _assertionWithFields(hash, 5, 1, '"origin":"https://untrusted.invalid","crossOrigin":false');
        require(_isValid(signer, MAGIC, abi.encode(hash), otherOrigin), "upstream origin policy changed");
    }

    function testUpstreamAcceptsBothP256SRepresentatives() public {
        bytes32 hash = keccak256("P256 malleability is independent of EOA rules");
        bytes memory assertion = _assertion(hash, 5, 1);
        (bytes memory authData, string memory fields, uint256 r, uint256 s) =
            abi.decode(assertion, (bytes, string, uint256, uint256));
        uint256 order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
        require(_isValid(signer, MAGIC, abi.encode(hash), assertion), "original P256 signature invalid");
        require(
            _isValid(signer, MAGIC, abi.encode(hash), abi.encode(authData, fields, r, order - s)),
            "P256 alternate s representative rejected"
        );
    }

    receive() external payable {}
}
