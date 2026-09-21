// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CenterSessionGuardV2, PackedUserOperation} from "../contracts/CenterSessionGuardV2.sol";

interface V2Vm {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function projectRoot() external view returns (string memory);
    function load(address target, bytes32 slot) external view returns (bytes32);
    function prank(address caller) external;
    function etch(address target, bytes calldata code) external;
}

contract CenterSessionGuardV2Test {
    V2Vm private constant vm = V2Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant ID = keccak256("center-session-fixture");
    address private constant ACCOUNT = address(0x123456);
    CenterSessionGuardV2 private guard;
    address private constant sponsor = 0x777777777777AeC03fd955926DbF81597e66834C;
    bytes32 private constant SPONSOR_CODE_HASH =
        0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc;

    function setUp() public {
        guard = new CenterSessionGuardV2();
        string memory sponsorJson = vm.readFile(
            string.concat(vm.projectRoot(), "/artifacts/PimlicoSingletonPaymasterV7.json")
        );
        vm.etch(sponsor, vm.parseJsonBytes(sponsorJson, ".deployedRuntimeBytecode"));
        require(sponsor.codehash == SPONSOR_CODE_HASH, "incorrect current sponsor fixture");
        guard.initializeWithMultiplexer(ACCOUNT, ID, abi.encode(config()));
    }

    function config() private pure returns (CenterSessionGuardV2.Config memory) {
        return CenterSessionGuardV2.Config(
            address(sponsor), SPONSOR_CODE_HASH, 1_000_000, 100, 10, 10_000_000, 1_000_000_000, 3, 130
        );
    }

    function operation() private view returns (PackedUserOperation memory op) {
        op.sender = ACCOUNT;
        op.callData = abi.encodeWithSelector(
            guard.EXECUTE_SELECTOR(), bytes32(0), abi.encodePacked(address(0x789), uint256(123), bytes4(0x12345678))
        );
        op.accountGasLimits = bytes32((uint256(100_000) << 128) | 200_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(2) << 128) | 10);
        op.paymasterAndData = abi.encodePacked(
            address(sponsor),
            uint128(30_000),
            uint128(20_000),
            bytes1(0),
            uint48(type(uint48).max),
            uint48(0),
            new bytes(65)
        );
    }

    function assertFailure(PackedUserOperation memory op) private {
        require(guard.checkUserOpPolicy(ID, op) == 1, "expected policy failure");
        (, uint256 gasUsed, uint256 costUsed, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 0 && costUsed == 0 && callsUsed == 0, "failure mutated counters");
    }

    function testCanonicalSponsorConsumesConservativeCostAndCallCount() public {
        PackedUserOperation memory op = operation();
        require(guard.checkUserOpPolicy(ID, op) == 0, "valid operation rejected");
        (, uint256 gasUsed, uint256 costUsed, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 400_000 && costUsed == 4_000_000 && callsUsed == 1, "incorrect accounting");
        require(
            guard.checkUserOpPolicy(ID, op) == 0 && guard.checkUserOpPolicy(ID, op) == 0, "remaining calls rejected"
        );
        require(guard.checkUserOpPolicy(ID, op) == 1, "fourth call accepted");
    }

    function testEmptyPaymasterCannotUseAccountNativePrefund() public {
        PackedUserOperation memory op = operation();
        op.paymasterAndData = "";
        assertFailure(op);
    }

    function testDifferentPaymasterAndChangedRuntimeFail() public {
        PackedUserOperation memory op = operation();
        op.paymasterAndData = abi.encodePacked(address(0x999), uint128(1), uint128(1));
        assertFailure(op);
        op = operation();
        vm.etch(address(sponsor), hex"00");
        assertFailure(op);
    }

    function testMaxFeeIsCappedEvenWhenEffectiveGasPriceCouldBeLow() public {
        PackedUserOperation memory op = operation();
        op.gasFees = bytes32(uint256(type(uint128).max));
        assertFailure(op);
    }

    function testGasPriorityAndSponsorDataBounds() public {
        PackedUserOperation memory op = operation();
        op.preVerificationGas = type(uint256).max;
        assertFailure(op);
        op = operation();
        op.accountGasLimits = bytes32(type(uint256).max);
        assertFailure(op);
        op = operation();
        op.gasFees = bytes32((uint256(11) << 128) | 100);
        assertFailure(op);
        op = operation();
        op.gasFees = bytes32((uint256(10) << 128) | 9);
        assertFailure(op);
        op = operation();
        op.paymasterAndData = abi.encodePacked(address(sponsor), new bytes(493));
        assertFailure(op);
        op = operation();
        op.paymasterAndData = abi.encodePacked(address(sponsor), new bytes(31));
        assertFailure(op);
    }

    function testTokenChargingPaymasterModeAndOversizedSignatureFail() public {
        PackedUserOperation memory op = operation();
        op.paymasterAndData[52] = bytes1(0x02);
        assertFailure(op);
        op.paymasterAndData[52] = bytes1(0x03);
        assertFailure(op);
        op = operation();
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, bytes2(0));
        assertFailure(op);
        op = operation();
        require(guard.checkUserOpPolicy(ID, op) == 0, "verifying mode65 rejected");
    }

    function testAlternateExecutionAndNoncanonicalEncodingFail() public {
        PackedUserOperation memory op = operation();
        op.callData = abi.encodeWithSelector(guard.EXECUTE_SELECTOR(), bytes32(uint256(1) << 248), bytes("batch"));
        assertFailure(op);
        op = operation();
        op.callData[4] = bytes1(0xff);
        assertFailure(op);
        op = operation();
        op.callData[0] = bytes1(0xff);
        assertFailure(op);
        op = operation();
        op.callData[67] = bytes1(0x60);
        assertFailure(op);
        op = operation();
        op.callData = abi.encodePacked(op.callData, bytes32(0));
        assertFailure(op);
        op = operation();
        op.callData[op.callData.length - 1] = bytes1(0x01);
        assertFailure(op);
    }

    function testCumulativeLimitsDoNotUseEffectiveGasPrice() public {
        CenterSessionGuardV2.Config memory limits = config();
        limits.totalSponsoredCostLimit = 7_999_999;
        guard.initializeWithMultiplexer(ACCOUNT, ID, abi.encode(limits));
        require(guard.checkUserOpPolicy(ID, operation()) == 0, "first rejected");
        require(guard.checkUserOpPolicy(ID, operation()) == 1, "cost cap exceeded");
        limits = config();
        limits.maxGasPerOperation = 500_000;
        limits.totalGasLimit = 799_999;
        guard.initializeWithMultiplexer(ACCOUNT, ID, abi.encode(limits));
        require(guard.checkUserOpPolicy(ID, operation()) == 0, "first gas rejected");
        require(guard.checkUserOpPolicy(ID, operation()) == 1, "gas cap exceeded");
    }

    function testUnauthorizedMultiplexerCannotChangeConfiguredSession() public {
        PackedUserOperation memory op = operation();
        vm.prank(address(0xBAD));
        guard.initializeWithMultiplexer(ACCOUNT, ID, abi.encode(config()));
        vm.prank(address(0xBAD));
        guard.checkUserOpPolicy(ID, op);
        (, uint256 gasUsed,, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 0 && callsUsed == 0, "cross-multiplexer mutation");
        op.sender = address(0xBAD);
        assertFailure(op);
    }

    function testInvalidConfigurationReverts() public {
        CenterSessionGuardV2.Config memory limits = config();
        limits.paymaster = address(0);
        (bool ok,) =
            address(guard).call(abi.encodeCall(guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encode(limits))));
        require(!ok, "zero paymaster accepted");
        limits = config();
        limits.maxGasPerOperation = type(uint256).max;
        limits.totalGasLimit = type(uint256).max;
        (ok,) = address(guard).call(abi.encodeCall(guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encode(limits))));
        require(!ok, "overflow configuration accepted");
        (ok,) = address(guard)
            .call(
                abi.encodeCall(
                    guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encodePacked(abi.encode(config()), bytes1(0)))
                )
            );
        require(!ok, "trailing config accepted");
    }

    function testFuzzOnlyCanonicalSponsorCanPass(uint256 fee, uint256 preVerificationGas, address paymaster) public {
        PackedUserOperation memory op = operation();
        op.gasFees = bytes32(fee);
        op.preVerificationGas = preVerificationGas;
        op.paymasterAndData = abi.encodePacked(
            paymaster, uint128(30_000), uint128(20_000), bytes1(0), uint48(type(uint48).max), uint48(0), new bytes(65)
        );
        uint256 result = guard.checkUserOpPolicy(ID, op);
        if (result == 0) {
            require(paymaster == address(sponsor), "unapproved sponsor");
            require(uint128(fee) > 0 && uint128(fee) <= 100 && uint128(fee >> 128) <= 10, "unbounded fee");
            require(preVerificationGas <= 650_000, "unbounded gas");
        }
    }

    function testFuzzAcceptedGasUsesRawMaxFee(uint64 seedFee, uint64 seedGas) public {
        PackedUserOperation memory op = operation();
        uint256 maxFee = uint256(seedFee) % 100 + 1;
        op.gasFees = bytes32(maxFee);
        op.preVerificationGas = uint256(seedGas) % 500_001;
        require(guard.checkUserOpPolicy(ID, op) == 0, "bounded operation rejected");
        (, uint256 gasUsed, uint256 costUsed, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 350_000 + op.preVerificationGas, "gas fields omitted");
        require(costUsed == gasUsed * maxFee && callsUsed == 1, "conservative fee or count mismatch");
    }

    function testBothGasOnlyFlagsUseTheSameAccounting() public {
        PackedUserOperation memory op = operation();
        require(guard.checkUserOpPolicy(ID, op) == 0, "restricted bundler flag rejected");
        op.paymasterAndData[52] = bytes1(0x01);
        require(guard.checkUserOpPolicy(ID, op) == 0, "all bundlers flag rejected");
        (, uint256 gasUsed, uint256 costUsed, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 800_000 && costUsed == 8_000_000 && callsUsed == 2, "flag changed gas accounting");
    }

    function testFuzzEveryTokenAndUnknownModeFails(uint8 seed) public {
        PackedUserOperation memory op = operation();
        op.paymasterAndData[52] = bytes1(uint8(uint256(seed) % 254 + 2));
        assertFailure(op);
    }

    function testFuzzOnlyExactLengthIsAccepted(uint16 seed) public {
        PackedUserOperation memory op = operation();
        uint256 length = uint256(seed) % 1024;
        bytes memory data = new bytes(length);
        for (uint256 i; i < length && i < op.paymasterAndData.length; ++i) data[i] = op.paymasterAndData[i];
        op.paymasterAndData = data;
        if (length == 130) require(guard.checkUserOpPolicy(ID, op) == 0, "canonical length rejected");
        else assertFailure(op);
    }

    function testAnotherAddressWithTheExactRuntimeCannotBeConfiguredOrUsed() public {
        address other = address(0x9911);
        vm.etch(other, sponsor.code);
        require(other.codehash == SPONSOR_CODE_HASH, "fixture copy failed");
        CenterSessionGuardV2.Config memory limits = config();
        limits.paymaster = other;
        (bool ok,) = address(guard).call(abi.encodeCall(guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encode(limits))));
        require(!ok, "identical runtime at another address configured");
        PackedUserOperation memory op = operation();
        op.paymasterAndData = abi.encodePacked(
            other, uint128(30_000), uint128(20_000), bytes1(0), uint48(type(uint48).max), uint48(0), new bytes(65)
        );
        assertFailure(op);
    }

    function testConfiguredHashCannotAuthorizeChangedRuntime() public {
        vm.etch(sponsor, hex"00");
        CenterSessionGuardV2.Config memory limits = config();
        limits.paymasterCodeHash = sponsor.codehash;
        (bool ok,) = address(guard).call(abi.encodeCall(guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encode(limits))));
        require(!ok, "matching unreviewed runtime configured");
        assertFailure(operation());
    }

    function testInvalidDataBoundsAndZeroBudgetsCannotBeConfigured() public {
        for (uint256 i; i < 7; ++i) {
            CenterSessionGuardV2.Config memory limits = config();
            if (i == 0) limits.maxPaymasterDataLength = 129;
            if (i == 1) limits.maxPaymasterDataLength = 131;
            if (i == 2) limits.maximumCalls = 0;
            if (i == 3) limits.totalSponsoredCostLimit = 0;
            if (i == 4) limits.totalGasLimit = limits.maxGasPerOperation - 1;
            if (i == 5) limits.maxFeePerGas = 0;
            if (i == 6) limits.maxPriorityFeePerGas = limits.maxFeePerGas + 1;
            (bool ok,) = address(guard).call(abi.encodeCall(guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encode(limits))));
            require(!ok, "invalid limit configured");
        }
    }

    function testCompilerStorageLayoutMatchesLiveStateAndNamespace() public {
        require(abi.encode(config()).length == 288, "Config wire layout changed");
        bytes32 idSlot = keccak256(abi.encode(ID, uint256(0)));
        bytes32 multiplexerSlot = keccak256(abi.encode(address(this), idSlot));
        bytes32 stateSlot = keccak256(abi.encode(ACCOUNT, multiplexerSlot));
        require(vm.load(address(guard), stateSlot) == bytes32(uint256(uint160(sponsor))), "paymaster slot changed");
        require(vm.load(address(guard), bytes32(uint256(stateSlot) + 1)) == SPONSOR_CODE_HASH, "hash slot changed");
        require(uint256(vm.load(address(guard), bytes32(uint256(stateSlot) + 7))) == ((uint256(130) << 128) | 3),
            "packed config word changed");
        require(guard.checkUserOpPolicy(ID, operation()) == 0, "canonical operation rejected");
        require(uint256(vm.load(address(guard), bytes32(uint256(stateSlot) + 8))) == 400_000, "gas counter slot changed");
        require(uint256(vm.load(address(guard), bytes32(uint256(stateSlot) + 9))) == 4_000_000, "cost counter slot changed");
        require(uint256(vm.load(address(guard), bytes32(uint256(stateSlot) + 10))) == 1, "call counter slot changed");
    }

    function testOversizedSponsorGasAndZeroFeeFailWithoutOverflow() public {
        PackedUserOperation memory op = operation();
        op.paymasterAndData = abi.encodePacked(
            sponsor, type(uint128).max, type(uint128).max, bytes1(0x01), uint48(type(uint48).max), uint48(0), new bytes(65)
        );
        assertFailure(op);
        op = operation();
        op.gasFees = bytes32(0);
        assertFailure(op);
    }
}
