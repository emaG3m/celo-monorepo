import { CeloTxObject } from '@celo/communication'
import { CURRENCY_ENUM } from '@celo/utils/src'
import { BigNumber } from 'bignumber.js'
import { call, delay, race, select, take } from 'redux-saga/effects'
import { TransactionEvents } from 'src/analytics/Events'
import ValoraAnalytics from 'src/analytics/ValoraAnalytics'
import { ErrorMessages } from 'src/app/ErrorMessages'
import { DEFAULT_FORNO_URL } from 'src/config'
import { getCurrencyAddress, getTokenContract } from 'src/tokens/saga'
import {
  sendTransactionAsync,
  SendTransactionLogEvent,
  SendTransactionLogEventType,
} from 'src/transactions/contract-utils'
import { TransactionContext } from 'src/transactions/types'
import Logger from 'src/utils/Logger'
import { assertNever } from 'src/utils/typescript'
import { getGasPrice } from 'src/web3/gas'
import { fornoSelector } from 'src/web3/selectors'

const TAG = 'transactions/send'

// TODO(Rossy) We need to avoid retries for now because we don't have a way of forcing serialization
// in cases where we have multiple parallel txs, like in verification. The nonces can get mixed up
// causing failures when a tx times out (rare but can happen on slow devices)
const TX_NUM_TRIES = 1 // Try txs up to this many times
const TX_RETRY_DELAY = 2000 // 2s
const TX_TIMEOUT = 45000 // 45s
const NONCE_TOO_LOW_ERROR = 'nonce too low'
const OUT_OF_GAS_ERROR = 'out of gas'
const ALWAYS_FAILING_ERROR = 'always failing transaction'
const KNOWN_TX_ERROR = 'known transaction'

const getLogger = (context: TransactionContext, fornoMode?: boolean) => {
  const txId = context.id
  const tag = context.tag ?? TAG
  return (event: SendTransactionLogEvent) => {
    switch (event.type) {
      case SendTransactionLogEventType.Started:
        Logger.debug(tag, `Sending transaction with id ${txId}`)
        ValoraAnalytics.track(TransactionEvents.transaction_start, {
          txId,
          description: context.description,
          fornoMode,
        })
        break
      case SendTransactionLogEventType.EstimatedGas:
        Logger.debug(tag, `Transaction with id ${txId} estimated gas: ${event.gas}`)
        ValoraAnalytics.track(TransactionEvents.transaction_gas_estimated, {
          txId,
          estimatedGas: event.gas,
        })
        break
      case SendTransactionLogEventType.TransactionHashReceived:
        Logger.debug(tag, `Transaction id ${txId} hash received: ${event.hash}`)
        ValoraAnalytics.track(TransactionEvents.transaction_hash_received, {
          txId,
          txHash: event.hash,
        })
        break
      case SendTransactionLogEventType.Confirmed:
        if (event.number > 0) {
          Logger.warn(tag, `Transaction id ${txId} extra confirmation received: ${event.number}`)
        }
        Logger.debug(tag, `Transaction confirmed with id: ${txId}`)
        ValoraAnalytics.track(TransactionEvents.transaction_confirmed, { txId })
        break
      case SendTransactionLogEventType.ReceiptReceived:
        Logger.debug(
          tag,
          `Transaction id ${txId} received receipt: ${JSON.stringify(event.receipt)}`
        )
        ValoraAnalytics.track(TransactionEvents.transaction_receipt_received, { txId })
        break
      case SendTransactionLogEventType.Failed:
        Logger.error(tag, `Transaction failed: ${txId}`, event.error)
        ValoraAnalytics.track(TransactionEvents.transaction_error, {
          txId,
          error: event.error.message,
        })
        break
      case SendTransactionLogEventType.Exception:
        Logger.error(tag, `Transaction Exception caught ${txId}: `, event.error)
        ValoraAnalytics.track(TransactionEvents.transaction_exception, {
          txId,
          error: event.error.message,
        })
        break
      default:
        assertNever(event)
    }
  }
}

// Sends a transaction and async returns promises for the txhash, confirmation, and receipt
// Only use this method if you need more granular control of the different events
// WARNING: this method doesn't have retry and timeout logic built in, turns out that's tricky
// to get right with this promise set interface. Prefer sendTransaction below
export function* sendTransactionPromises(
  tx: CeloTxObject<any>,
  account: string,
  context: TransactionContext,
  nonce?: number,
  staticGas?: number
) {
  Logger.debug(
    `${TAG}@sendTransactionPromises`,
    `Going to send a transaction with id ${context.id}`
  )

  const stableToken = yield getTokenContract(CURRENCY_ENUM.DOLLAR)
  const stableTokenBalance = yield call([stableToken, stableToken.balanceOf], account)

  const fornoMode: boolean = yield select(fornoSelector)
  let gasPrice: BigNumber | undefined

  Logger.debug(
    `${TAG}@sendTransactionPromises`,
    `Sending tx ${context.id} in ${fornoMode ? 'forno' : 'geth'} mode`
  )
  if (fornoMode) {
    // In dev mode, verify that we are actually able to connect to the network. This
    // ensures that we get a more meaningful error if the forno server is down, which
    // can happen with networks without SLA guarantees like `integration`.
    if (__DEV__) {
      yield call(verifyUrlWorksOrThrow, DEFAULT_FORNO_URL)
    }

    gasPrice = yield getGasPrice(CURRENCY_ENUM.DOLLAR)
  }
  const transactionPromises = yield call(
    sendTransactionAsync,
    tx,
    account,
    // Use stableToken to pay fee, unless its balance is Zero
    // then use Celo (goldToken) to pay fee (pass undefined)
    // TODO: make it transparent for a user
    // TODO: check for balance should be more than fee instead of zero
    stableTokenBalance.isGreaterThan(0)
      ? yield call(getCurrencyAddress, CURRENCY_ENUM.DOLLAR)
      : undefined,
    getLogger(context, fornoMode),
    staticGas,
    gasPrice ? gasPrice.toString() : gasPrice,
    nonce
  )
  return transactionPromises
}

// Send a transaction and await for its confirmation
// Use this method for sending transactions and awaiting them to be confirmed
export function* sendTransaction(
  tx: CeloTxObject<any>,
  account: string,
  context: TransactionContext,
  staticGas?: number,
  cancelAction?: string
) {
  const sendTxMethod = function*(nonce?: number) {
    const { confirmation } = yield call(
      sendTransactionPromises,
      tx,
      account,
      context,
      nonce,
      staticGas
    )
    const result = yield confirmation
    return result
  }
  yield call(wrapSendTransactionWithRetry, sendTxMethod, context, cancelAction)
}

export function* wrapSendTransactionWithRetry(
  sendTxMethod: (nonce?: number) => Generator<any, any, any>,
  context: TransactionContext,
  cancelAction?: string
) {
  for (let i = 1; i <= TX_NUM_TRIES; i++) {
    try {
      const { result, timeout, cancel } = yield race({
        result: call(sendTxMethod),
        timeout: delay(TX_TIMEOUT * i),
        ...(cancelAction && {
          cancel: take(cancelAction),
        }),
      })

      if (timeout) {
        Logger.error(
          `${TAG}@wrapSendTransactionWithRetry`,
          `tx ${context.id} timeout for attempt ${i}`
        )
        throw new Error(ErrorMessages.TRANSACTION_TIMEOUT)
      } else if (cancel) {
        Logger.warn(
          `${TAG}@wrapSendTransactionWithRetry`,
          `tx ${context.id} cancelled for attempt ${i}`
        )
        return
      }

      Logger.debug(
        `${TAG}@wrapSendTransactionWithRetry`,
        `tx ${context.id} successful for attempt ${i} with result ${result}`
      )
      return
    } catch (err) {
      Logger.error(`${TAG}@wrapSendTransactionWithRetry`, `Tx ${context.id} failed`, err)

      if (!shouldTxFailureRetry(err)) {
        return
      }

      if (i + 1 <= TX_NUM_TRIES) {
        yield delay(TX_RETRY_DELAY)
        Logger.debug(
          `${TAG}@wrapSendTransactionWithRetry`,
          `Tx ${context.id} retrying attempt ${i + 1}`
        )
      } else {
        throw err
      }
    }
  }
}

function shouldTxFailureRetry(err: any) {
  if (!err || !err.message || typeof err.message !== 'string') {
    return true
  }
  const message = err.message.toLowerCase()

  // Web3 doesn't like the tx, it's invalid (e.g. fails a require), or funds insufficient
  if (message.includes(OUT_OF_GAS_ERROR)) {
    Logger.debug(
      `${TAG}@shouldTxFailureRetry`,
      'Out of gas or invalid tx error. Will not reattempt.'
    )
    return false
  }

  // Similar to case above
  if (message.includes(ALWAYS_FAILING_ERROR)) {
    Logger.debug(`${TAG}@shouldTxFailureRetry`, 'Transaction always failing. Will not reattempt')
    return false
  }

  // Geth already knows about the tx of this nonce, no point in resending it
  if (message.includes(KNOWN_TX_ERROR)) {
    Logger.debug(`${TAG}@shouldTxFailureRetry`, 'Known transaction error. Will not reattempt.')
    return false
  }

  // Nonce too low, probably because the tx already went through
  if (message.includes(NONCE_TOO_LOW_ERROR)) {
    Logger.debug(
      `${TAG}@shouldTxFailureRetry`,
      'Nonce too low, possible from retrying. Will not reattempt.'
    )
    return false
  }

  return true
}

async function verifyUrlWorksOrThrow(url: string) {
  try {
    await fetch(url)
  } catch (e) {
    Logger.error(
      'contracts@verifyUrlWorksOrThrow',
      `Failed to perform HEAD request to url: \"${url}\"`,
      e
    )
    throw new Error(`Failed to perform HEAD request to url: \"${url}\", is it working?`)
  }
}
