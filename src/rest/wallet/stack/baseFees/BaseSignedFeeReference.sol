// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LibZip} from "./LibZip.sol";

/// @notice Test-only independent Solidity reference, not a deployed Base GasPriceOracle.
/// @dev Compression is exact upstream Solady. Fee arithmetic is a small Center wrapper around
/// Base's pinned Fjord/Isthmus/Jovian equations; see README.md for upstream provenance.
/// Input is the FULL SIGNED type-2 envelope. There is deliberately NO unsigned-oracle +68 padding.
contract BaseSignedFeeReference {
    struct Parameters {
        bool jovian;
        uint256 l1BaseFee;
        uint256 l1BlobBaseFee;
        uint32 l1BaseFeeScalar;
        uint32 l1BlobBaseFeeScalar;
        uint32 operatorFeeScalar;
        uint64 operatorFeeConstant;
    }

    struct Quote {
        uint256 fastLzLength;
        uint256 estimatedSizeScaled;
        uint256 l1FeeAtParameters;
        uint256 operatorMaximumAtParameters;
        uint256 executionMaximum;
        uint256 totalMaximumAtParameters;
    }

    function compressedLength(bytes memory raw) public pure returns (uint256) {
        require(raw.length <= 131072, "reference input bound");
        return LibZip.flzCompress(raw).length;
    }

    function quote(bytes memory raw, uint64 gasLimit, uint256 maxFeePerGas, uint256 value, Parameters memory p)
        external pure returns (Quote memory q)
    {
        q.fastLzLength = compressedLength(raw);
        int256 size = int256(q.fastLzLength) * 836500 - 42585600;
        q.estimatedSizeScaled = size > 100000000 ? uint256(size) : 100000000;
        uint256 scaledPrice = 16 * uint256(p.l1BaseFeeScalar) * p.l1BaseFee
            + uint256(p.l1BlobBaseFeeScalar) * p.l1BlobBaseFee;
        q.l1FeeAtParameters = q.estimatedSizeScaled * scaledPrice / 1000000000000;
        q.operatorMaximumAtParameters = p.jovian
            ? uint256(gasLimit) * p.operatorFeeScalar * 100 + p.operatorFeeConstant
            : uint256(gasLimit) * p.operatorFeeScalar / 1000000 + p.operatorFeeConstant;
        q.executionMaximum = uint256(gasLimit) * maxFeePerGas;
        q.totalMaximumAtParameters = value + q.executionMaximum + q.l1FeeAtParameters + q.operatorMaximumAtParameters;
    }
}
