require('dotenv').config();
const cosmosjs = require('@cosmostation/cosmosjs');
const cron = require('node-cron');
import { postTxKava, getTxKava } from '../common/txs.js';
import {
  newMsgCreateCDP,
  newMsgDeposit,
  newMsgWithdraw,
  newMsgDrawDebt,
  newMsgRepayDebt
} from '../common/msg.js';
import { parseCurrCDP, parseModuleParams, parseResError } from './parser.js';

// Load chain details, credentials
const mnemonic = process.env.MNEMONIC;
const lcdURL = process.env.LCD_URL;
const chainID = process.env.CHAIN_ID;

// Load params
const cDenom = process.env.COLLATERAL_DENOM;

// Initiate Kava blockchain
const kava = cosmosjs.network(lcdURL, chainID);
kava.setBech32MainPrefix('kava');
kava.setPath("m/44'/118'/0'/0/0");

// // Load account credentials
const address = kava.getAddress(mnemonic);
const ecpairPriv = kava.getECPairPriv(mnemonic);

// Primary cron routine
var routine = async (lcdURL, address, cDenom) => {
  getTxKava(lcdURL, '/cdp/parameters', {}).then(modParams => {
    let height = modParams.height;
    let modResult = modParams.result;
    if (modResult.collateral_params == undefined) {
      console.log('Request for CDP module params unsuccessful:\n');
      console.log(modResult);
      return console.log('\nExiting.');
    }
    let params = parseModuleParams(modResult.collateral_params, cDenom);
    getTxKava(lcdURL, '/auth/accounts/'.concat(address)).then(balance => {
      if (balance == undefined) {
        console.log(`Error: Addres ${address} has no balance`);
        return;
			}
			console.log(`Balance response: ${JSON.stringify(balance)}`)
      let collateralBalance = getCollateralBalance(balance.result, cDenom);
      getTxKava(lcdURL, '/cdp/cdps/cdp/'.concat(address + '/' + cDenom), {
        height: height
      }).then(resCdp => {
        if (resCdp == undefined) {
          console.log(
            'Error: Kava query response is undefined. Cannot proceed.'
          );
          return;
        }
        // Response doesn't contain a cdp
        if (resCdp.response != undefined) {
          let create = parseResError(resCdp);
          if (create == true) {
            getTxKava(lcdURL, '/pricefeed/price/'.concat(params.marketID), {
              height: height
            }).then(resPrice => {
              let res = resPrice.result;
              let price = Number(res.price);
              cdpCreate(cDenom, params, price, collateralBalance);
            });
          }
        }
        if (resCdp.result != undefined) {
          // Response contains a cdp
          if (resCdp.result.cdp != undefined) {
            let cdp = parseCurrCDP(resCdp.result);

            console.log('CDP ID:', cdp.ID);
            console.log('\tCollateral Value:', cdp.cValue);
            console.log('\tCollateralization:', cdp.cRatio);
            console.log();

            cdpAction(cdp, params.pDebtLimit);
            return;
          }
        }
      });
    });
  });
};

// Create a new CDP with the minimum debt limit
var cdpCreate = async (cDenom, params, price, collateralBalance) => {
	let amountOfCollateral = Number(collateralBalance) * Math.pow(10, -1 * Number(params.conversion))
	let collateralToLock = (Math.random() * (0.80 - 0.0200) + 0.0200) * amountOfCollateral
	let valueOfCollateral = price * collateralToLock
	let collateralInt = Math.trunc(collateralToLock * Math.pow(10, Number(params.conversion)))
	let principalToLock = ((Math.random() * (0.65 - 0.0200) + 0.0200) * valueOfCollateral) * Math.pow(10, 6)
	let principalInt = Math.trunc(principalToLock)
  console.log(
    'Creating CDP. Collateral: '
      .concat(collateralInt + cDenom)
      .concat(' Principal: ' + (principalInt + params.pDenom) + '.')
  );
  let msgCreateCDP = newMsgCreateCDP(
    address,
    cDenom,
    collateralInt,
    params.pDenom,
    principalInt
  );
  postTxKava(kava, chainID, address, ecpairPriv, msgCreateCDP);
};

var getCollateralBalance = (res, cDenom) => {
  for (var i = 0; i < res.coins.length; i++) {
    if (res.coins[i].denom == cDenom) {
      return { collateral_balance: res.coins[i].amount };
    }
  }
  return null;
};

// Perform deposit, withdraw, draw, or repay action on existing CDP
var cdpAction = async (cdp, debtLimit) => {
  let cDenom = cdp.cDenom;
  let pDenom = cdp.pDenom;

  // Get random amount between 0-9% of current collateral
  let cAmount = Math.floor(Math.random() * (cdp.currCAmount / 10));

  // Set principal amount to debt limit 0-1% of current principal
  let pAmount = Math.floor(Math.random() * (cdp.currPAmount / 2));
  // TODO: Revist: pAmount = debtLimit

  let evenOrOdd = Math.floor(Math.random() * 2) + 1;
  if (Number(cdp.cRatio) > Number(2.2)) {
    // If collateralization ratio is above 220%
    if (evenOrOdd % 2 == 0) {
      // Withdraw collateral
      console.log(
        '\tAttempting to withdraw '.concat(cAmount + cDenom.concat('...'))
      );
      let msgWithdraw = newMsgWithdraw(address, address, cDenom, cAmount);
      postTxKava(kava, chainID, address, ecpairPriv, msgWithdraw);
    } else {
      // Draw principal
      console.log(
        '\tAttempting to draw '.concat(pAmount + pDenom.concat('...'))
      );
      let msgDraw = newMsgDrawDebt(address, cDenom, pDenom, pAmount);
      postTxKava(kava, chainID, address, ecpairPriv, msgDraw);
    }
  } else {
    // If collateralization ratio is below 220%
    if (evenOrOdd % 2 == 0) {
      // Deposit collateral
      console.log(
        '\tAttempting to deposit '.concat(cAmount + cDenom.concat('...'))
      );
      let msgDeposit = newMsgDeposit(address, address, cDenom, cAmount);
      postTxKava(kava, chainID, address, ecpairPriv, msgDeposit);
    } else {
      // Repay principal
      console.log(
        '\tAttempting to repay '.concat(pAmount + pDenom.concat('...'))
      );
      let msgRepay = newMsgRepayDebt(address, cDenom, pDenom, pAmount);
      postTxKava(kava, chainID, address, ecpairPriv, msgRepay);
    }
  }
};

// Start cron job
var task = cron.schedule('* * * * *', () => {
  routine(lcdURL, address, cDenom);
});

task.start();
