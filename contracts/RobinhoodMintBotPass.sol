// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "erc721a/contracts/ERC721A.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title Robinhood Mint Bot Pass
/// @notice Test collection for the RH Mint Bot: 10,000 supply, all public, 0.0001 ETH each.
///         No per-wallet cap and no tx.origin gate, so spray / sequencer-direct / bulk-contract
///         mint methods can all be exercised against it.
///         - mint(qty)        -> mints to msg.sender      (spray / sequencer-direct)
///         - mintTo(to, qty)  -> mints to `to`            (bulk: set `to` = your address)
contract RobinhoodMintBotPass is ERC721A, Ownable {
    uint256 public constant MAX_SUPPLY = 10_000;
    uint256 public constant PRICE = 0.0001 ether;

    bool public mintOpen = true;
    string private _baseTokenURI;

    constructor(string memory baseURI_)
        ERC721A("Robinhood Mint Bot Pass", "RHMBP")
        Ownable(msg.sender)
    {
        _baseTokenURI = baseURI_;
    }

    function mint(uint256 quantity) external payable {
        _publicMint(msg.sender, quantity);
    }

    function mintTo(address to, uint256 quantity) external payable {
        _publicMint(to, quantity);
    }

    function _publicMint(address to, uint256 quantity) internal {
        require(mintOpen, "mint closed");
        require(quantity > 0, "quantity = 0");
        require(_totalMinted() + quantity <= MAX_SUPPLY, "sold out");
        require(msg.value >= PRICE * quantity, "underpaid");
        _mint(to, quantity);
    }

    function totalMinted() external view returns (uint256) {
        return _totalMinted();
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // ---- owner ----
    function setBaseURI(string calldata uri) external onlyOwner {
        _baseTokenURI = uri;
    }

    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
    }

    function withdraw() external onlyOwner {
        (bool ok, ) = payable(owner()).call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}
