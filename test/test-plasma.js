/* eslint-env mocha */
/* eslint-disable no-unused-expressions */

/* NOTE: filename has a 0 appended so that mocha loads this first,
so that contract deployment is only done once.  If you create a new
test, do it with a before() as in other files, not this one */

const chai = require('chai')
const expect = chai.expect
const assert = chai.assert

const Web3 = require('web3')
const BN = Web3.utils.BN

const plasmaUtils = require('plasma-utils')
const PlasmaMerkleSumTree = plasmaUtils.PlasmaMerkleSumTree
const models = plasmaUtils.serialization.models
const Transaction = models.Transaction
const TransferProof = models.TransferProof
const TransactionProof = models.TransactionProof
const setup = require('./setup-plasma')
const web3 = setup.web3

const CHALLENGE_PERIOD = 20

describe('Plasma Initialization', () => {
  let bytecode, abi, plasma, freshContractSnapshot
  let randomTXEncoding, randomTX, randomTransferIndex
  let tx, txs, tree

  // BEGIN SETUP

  before(async () => {
    // setup ganache, deploy, etc.
    [
      bytecode, abi, plasma, freshContractSnapshot
    ] = await setup.setupPlasma()
    const numTransfers = 4
    const blockNum = 1
    randomTXEncoding = genRandomTX(blockNum, numTransfers)
    randomTX = new Transaction(randomTXEncoding)
    randomTXEncoding = '0x' + randomTXEncoding
    randomTransferIndex = Math.floor(Math.random() * 4)
    
    // tree for testing branch checking
    tx = new Transaction(encodedTransaction)
    txs = [tx, randomTX, randomTX]
    tree = new PlasmaMerkleSumTree(txs)
  })
  it.only('Should compile the vyper contract without errors', async () => {
    expect(abi).to.exist
    expect(bytecode).to.exist
    expect(plasma).to.exist
    expect(web3).to.exist
  })

  // BEGIN OPERATOR SECTION

  it.only('should allow a block to be published by the operator', async () => {
    const dummyBlockHash = '0x000000000000000000000000000000000000000000000000000000000000000'
    await setup.mineNBlocks(10) // blocktime is 10
    await plasma.methods.submitBlock(dummyBlockHash).send({ value: 0, from: web3.eth.accounts.wallet[0].address, gas: 4000000 }).catch((error) => { console.log('send callback failed: ', error) })
  })

  // BEGIN DEPOSITS AND EXITS SECTION

  it('should allow a first deposit and add it to the deposits correctly', async () => {
    const depositSize = 50
    await plasma.methods.submitDeposit().send({ value: depositSize, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    const exitableStart = await plasma.methods.exitable(depositSize).call()
    const depositStart = await plasma.methods.deposits__start(depositSize).call()
    const depositer = await plasma.methods.deposits__depositer(depositSize).call()
    assert.equal(exitableStart, '0')
    assert.equal(depositStart, '0')
    assert.equal(depositer, web3.eth.accounts.wallet[1].address)
  })
  it('should allow a second deposit and add it to the deposits correctly', async () => {
    const depositSize = 500
    await plasma.methods.submitDeposit().send({ value: depositSize, from: web3.eth.accounts.wallet[2].address, gas: 4000000 })
    const depositEnd = 550 // 550 hardcoded from above deposit of 50
    const exitableStart = await plasma.methods.exitable(depositEnd).call()
    const depositStart = await plasma.methods.deposits__start(depositEnd).call()
    const depositer = await plasma.methods.deposits__depositer(depositEnd).call()
    assert.equal(exitableStart, '0')
    assert.equal(depositStart, '50')
    assert.equal(depositer, web3.eth.accounts.wallet[2].address)
  })
  it('should allow that users `beginExit`s', async () => {
    const plasmaBlock = '0'
    const exitStart = '0'
    const exitEnd = '10'
    await plasma.methods.beginExit(plasmaBlock, exitStart, exitEnd).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    const exitID = 0 // hardcode since this is all a deterministic test
    const exiter = await plasma.methods.exits__exiter(exitID).call()
    assert.equal(exiter, web3.eth.accounts.wallet[1].address)
  })
  it('should properly finalize leftmost, rightmost, and middle exits', async () => {
    // this test finalizes exits in order of left, right, middle.
    // LEFT EXIT: (0, 10) -- beginExit() already happened in the last test
    await setup.mineNBlocks(CHALLENGE_PERIOD) // finalizing exits in order of left, right, middle for testing variety
    await plasma.methods.finalizeExit(0, 550).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })

    // now do the end: exiting 300, 550 -> exitID 1
    const plasmaBlock = '0'
    await plasma.methods.beginExit(plasmaBlock, 300, 550).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    await setup.mineNBlocks(CHALLENGE_PERIOD)
    await plasma.methods.finalizeExit(1, 550).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })

    // now do the middle: 100,200 -> exitID 2
    await plasma.methods.beginExit(plasmaBlock, 100, 200).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    await setup.mineNBlocks(CHALLENGE_PERIOD)
    await plasma.methods.finalizeExit(2, 300).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })

    const firstExitableStart = await plasma.methods.exitable(100).call()
    const secondExitableStart = await plasma.methods.exitable(300).call()
    assert.equal(firstExitableStart, '10')
    assert.equal(secondExitableStart, '200')
  })
  it('should properly process a new deposit after the rightmost coin was exited', async () => {
    const depositSize = 420
    await plasma.methods.submitDeposit().send({ value: depositSize, from: web3.eth.accounts.wallet[2].address, gas: 4000000 })
    const depositEnd = 970 // total deposits were now 50 + 500 + 420
    const exitableStart = await plasma.methods.exitable(depositEnd).call()
    assert.equal(exitableStart, '550')
  })

  // BEGIN DECODING SECTION

  it('should getLeafHash of an encoded transaction', async () => {
    const possibleHash = await plasma.methods.getLeafHash(randomTXEncoding).call()
    assert.equal(possibleHash, randomTX.hash)
  })
  it('should decodeBlockNumber from a tx', async () => {
    const decoded = await plasma.methods.decodeBlockNumber(randomTXEncoding).call()
    const expected = new BN(randomTX.args.block).toString()
    assert.equal(decoded, expected)
  })
  it('should decodeNumTransfers from a tx', async () => {
    const decoded = await plasma.methods.decodeNumTransfers(randomTXEncoding).call()
    const expected = new BN(randomTX.args.transfers.length).toString()
    assert.equal(decoded, expected)
  })
  it('should decode ith transfer sender', async () => {
    const decoded = await plasma.methods.decodeIthSender(randomTransferIndex, randomTXEncoding).call()
    const expected = randomTX.args.transfers[randomTransferIndex].sender.toLowerCase()
    assert.equal(decoded.toLowerCase(), expected)
  })
  it('should decode ith transfer recipient', async () => {
    const decoded = await plasma.methods.decodeIthRecipient(randomTransferIndex, randomTXEncoding).call()
    const expected = randomTX.args.transfers[randomTransferIndex].recipient.toLowerCase()
    assert.equal(decoded.toLowerCase(), expected)
  })
  it('should decode ith token type bytes', async () => {
    const decoded = await plasma.methods.decodeIthTokenTypeBytes(randomTransferIndex, randomTXEncoding).call()
    const expected = '0x' + randomTX.args.transfers[randomTransferIndex].token.toString(16)
    assert.equal(decoded, expected)
  })
  it('should decode ith token type as uint', async () => {
    const decoded = await plasma.methods.decodeIthTokenType(randomTransferIndex, randomTXEncoding).call()
    const expected = randomTX.args.transfers[randomTransferIndex].token.toString()
    assert.equal(decoded, expected)
  })
  it('should decode ith transfer range', async () => {
    const decoded = await plasma.methods.decodeIthTransferRange(3, randomTXEncoding).call()
    const expectedType = randomTX.args.transfers[3].token.toString(16, 4)
    const expectedStart = randomTX.args.transfers[3].start.toString(16, 12)
    const expectedEnd = randomTX.args.transfers[3].end.toString(16, 12)
    const expected = [
      new BN(expectedType + expectedStart, 16).toString(),
      new BN(expectedType + expectedEnd, 16).toString()
    ]
    assert.equal(decoded[0], expected[0])
    assert.equal(decoded[1], expected[1])
  })

  const encodedTransfer = '43aaDF3d5b44290385fe4193A1b13f15eF3A4FD5a12bcf1159aa01c739269391ae2d0be4037259f300000001000000000000000000000002000000000000000000000003'
  const decodedTransfer = {
    sender: '0x43aaDF3d5b44290385fe4193A1b13f15eF3A4FD5',
    recipient: '0xa12bcf1159aa01c739269391ae2d0be4037259f3',
    token: new BN('1', 'hex'),
    start: new BN('2', 'hex'),
    end: new BN('3', 'hex')
  }
  const encodedSignature = '1bd693b532a80fed6392b428604171fb32fdbf953728a3a7ecc7d4062b1652c04224e9c602ac800b983b035700a14b23f78a253ab762deab5dc27e3555a750b354'
  const decodedSignature = {
    v: '1b',
    r: 'd693b532a80fed6392b428604171fb32fdbf953728a3a7ecc7d4062b1652c042',
    s: '24e9c602ac800b983b035700a14b23f78a253ab762deab5dc27e3555a750b354'
  }
  const encodedTransaction = '00000001' + '01' + encodedTransfer
  const decodedTransaction = {
    block: new BN('1', 'hex'),
    transfers: [
      decodedTransfer
    ]
  }
  const encodedTransferProof = '00000000000000000000000000000003' + '00000000000000000000000000000004' + encodedSignature + '01' + '563f225cdc192264a90e7e4b402815479c71a16f1593afa4fc6323e18583472affffffffffffffffffffffffffffffff'
  const decodedTransferProof = {
    parsedSum: new BN('3', 'hex'),
    leafIndex: new BN('4', 'hex'),
    inclusionProof: [
      '563f225cdc192264a90e7e4b402815479c71a16f1593afa4fc6323e18583472affffffffffffffffffffffffffffffff'
    ],
    signature: decodedSignature
  }
  const testTransferProof = new TransferProof(decodedTransferProof)
  const encodedTransactionProof = '01' + encodedTransferProof
  const decodedTransactionProof = {
    transferProofs: [
      decodedTransferProof
    ]
  }
  const transactionProof = new TransactionProof(encodedTransactionProof)

  it('should decodeParsedSumBytes', async () => {
    const decoded = await plasma.methods.decodeParsedSumBytes('0x' + encodedTransferProof).call()
    const expected = '0x' + testTransferProof.args.parsedSum.toString(16, 32)
    assert.equal(decoded, expected)
  })
  it('should decodeParsedSum', async () => {
    const decoded = await plasma.methods.decodeParsedSum('0x' + encodedTransferProof).call()
    const expected = testTransferProof.args.parsedSum.toString()
    assert.equal(decoded, expected)
  })
  it('should decodeLeafIndex', async () => {
    const decoded = await plasma.methods.decodeLeafIndex('0x' + encodedTransferProof).call()

    const expected = testTransferProof.args.leafIndex.toString()
    assert.equal(decoded, expected)
  })
  it('should decodeSignature', async () => {
    const decoded = await plasma.methods.decodeSignature('0x' + encodedTransferProof).call()
    const expected = [
      '0x' + new BN(testTransferProof.args.signature.v).toString(16),
      '0x' + new BN(testTransferProof.args.signature.r).toString(16),
      '0x' + new BN(testTransferProof.args.signature.s).toString(16)
    ]
    assert.equal(decoded[0], expected[0])
    assert.equal(decoded[1], expected[1])
    assert.equal(decoded[2], expected[2])
  })
  it.only('should decodeNumInclusionProofNodes', async () => {
    debugger
    const decoded = await plasma.methods.decodeNumInclusionProofNodes('0x' + encodedTransferProof).call()

    const expected = testTransferProof.args.inclusionProof.length
    assert.equal(decoded, expected)
  })
  it('should decodeIthInclusionProofNode', async () => {
    const decoded = await plasma.methods.decodeIthInclusionProofNode(0, '0x' + encodedTransferProof).call()
    const expected = '0x' + new BN(testTransferProof.args.inclusionProof[0]).toString(16)
    assert.equal(decoded, expected)
  })
  it('should decodeNumTransactionProofs', async () => {
    const decoded = await plasma.methods.decodeNumTransactionProofs('0x' + encodedTransactionProof).call()
    const expected = new BN(transactionProof.args.transferProofs.length).toString()
    assert.equal(decoded, expected)
  })
  it('should decodeIthTransferProofWithNumNodes', async () => {
    const decoded = await plasma.methods.decodeIthTransferProofWithNumNodes(0, 1, '0x' + encodedTransactionProof).call()
    const expected = '0x' + encodedTransferProof
    assert.equal(decoded, expected)
  })

  it.only('should checkTransferProofAndGetBounds', async () => {
    await plasma.methods.submitBlock('0x' + tree.root().hash).send({ value: 0, from: web3.eth.accounts.wallet[0].address, gas: 4000000 })
    const index = 0
    let transferProof = tree.getTransferProof(index)
    debugger
    const possibleImplicitBounds = await plasma.methods.checkTransferProofAndGetBounds(
      web3.utils.soliditySha3('0x' + txs[index].encoded),
      1,
      '0x' + transferProof.encoded
    ).call()
    debugger
    assert.equal(possibleImplicitBounds[0], new BN(txs[index].args.transfers[0].start))
    assert(new BN(possibleImplicitBounds[1]).gte(new BN(txs[index].args.transfers[0].end)))
  })
  // it('should properly check full tx proofs and get transfer & blocknumber', async () => {
  //   for (let i = 0; i < 100; i++) { let tx, index, proof, parsedSum, proofString; try {
  //    index = Math.floor(Math.random() * txs.length)
  //    tx = txs[index]
  //    proof = tree.getInclusionProof(index)
  //    parsedSum = proof[0].sum
  //   proof.shift()
  //    proofString = '0x'
  //   proof.forEach((element) => { proofString = proofString + element.hash + element.sum.toString(16, 32) })
  //   const transfer = await plasma.methods.checkTXValidityAndGetTransfer(
  //     0,
  //     '0x' + tx.encoded,
  //     '0x' + parsedSum.toString(16, 32),
  //     '0x' + new BN(index).toString(16, 2),
  //     proofString
  //   ).call()
  //   const returnedTo = transfer[0]
  //   const returnedFrom = transfer[1]
  //   const returnedStart = transfer[2]
  //   const returnedEnd = transfer[3]
  //   const expectedTo = tx.args.transfer.recipient
  //   const expectedFrom = tx.args.transfer.sender
  //   const expectedStart = new BN(tx.args.transfer.start).toString()
  //   const expectedEnd = new BN(tx.args.transfer.end).toString()
  //   assert.equal(returnedTo, expectedTo)
  //   assert.equal(returnedFrom, expectedFrom)
  //   assert.equal(returnedStart, expectedStart)
  //   assert.equal(returnedEnd, expectedEnd)
  //   } catch { debugger }
  // }
  // })
  // it('should allow inclusionChallenges and their response', async () => {
  //   const index = Math.floor(Math.random() * txs.length)
  //   const tx = txs[index]
  //   const start = new BN(tx.args.transfer.start)
  //   const end = new BN(tx.args.transfer.end)
  //   const a = await plasma.methods.beginExit(1, start, end, 0).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
  //   debugger
  // })
})

function genRandomTX (blockNum, numTransfers) {
  let randomTransfers = []
  for (let i = 0; i < numTransfers; i++) {
    // fuzz a random encoding to test decoding with
    let randomVals = ''
    for (let i = 0; i < 28; i++) { // random start, end, type = 12+12+4 bytes
      const randHex = Math.floor(Math.random() * 256)
      randomVals += new BN(randHex, 10).toString(16, 2)
    }
    randomTransfers +=
      web3.eth.accounts.wallet[i].address.slice(2) +
      web3.eth.accounts.wallet[i + 1].address.slice(2) +
      randomVals
    // can't have invalid addresses so ignore this partthe 33rd byte is the numTransfers which isn't random--it's 4
  }
  return new BN(blockNum).toString(16, 8) + new BN(numTransfers).toString(16, 2) + randomTransfers
}
