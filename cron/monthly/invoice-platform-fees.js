#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import { parse as json2csv } from 'json2csv';
import { entries, groupBy, omit, round, sumBy } from 'lodash';
import moment from 'moment';

import expenseStatus from '../../server/constants/expense_status';
import expenseTypes from '../../server/constants/expense_type';
import { FEES_ON_TOP_SETTLEMENT_EXPENSE_PROPERTIES, TransactionTypes } from '../../server/constants/transactions';
import { uploadToS3 } from '../../server/lib/awsS3';
import { generateKey } from '../../server/lib/encryption';
import models, { sequelize } from '../../server/models';

// Only run on the first of the month
const date = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();
if (config.env === 'production' && date.getDate() !== 1) {
  console.log('OC_ENV is production and today is not the first of month, script aborted!');
  process.exit();
}

export async function run() {
  console.info(`Invoicing hosts pending fees and tips for ${moment(date).subtract(1, 'month').format('MMMM')}.`);
  const [pastMonthTransactions] = await sequelize.query(
    `
    WITH "platformTips" AS (
      SELECT
        t."createdAt",
        t.description,
        round(t."netAmountInCollectiveCurrency"::float / COALESCE((t."data"->>'hostToPlatformFxRate')::float, 1)) AS "amount",
        ot."hostCurrency" AS "currency",
        ot."CollectiveId",
        c."slug" AS "CollectiveSlug",
        ot."HostCollectiveId",
        h."name" AS "HostName",
        ot."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Platform Tip'::TEXT AS "source"
      FROM
        "Transactions" t
      LEFT JOIN "Transactions" ot ON
        t."PlatformTipForTransactionGroup"::uuid = ot."TransactionGroup"
        AND ot.type = 'CREDIT'
        AND ot."PlatformTipForTransactionGroup" IS NULL
      LEFT JOIN "Collectives" h ON
        ot."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        ot."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month', date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month', date :date)
        AND t."deletedAt" IS NULL
        AND t."CollectiveId" = 1
        AND t."PlatformTipForTransactionGroup" IS NOT NULL
        AND t."type" = 'CREDIT'
        AND (
          pm."service" != 'stripe'
          OR pm.service IS NULL
        )
        AND (
          spm.service IS NULL
          OR spm.service != 'stripe'
        )
        AND (h."type" = 'ORGANIZATION' AND h."isActive" = TRUE AND h."isHostAccount")
      ORDER BY
        t."createdAt"
    ),
    "platformFees" AS (
      SELECT
        t."createdAt",
        t.description,
        -t."platformFeeInHostCurrency" AS "amount",
        t."hostCurrency" AS "currency",
        t."CollectiveId",
        c."slug" AS "CollectiveSlug",
        t."HostCollectiveId",
        h."name" AS "HostName",
        t."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Platform Fee'::TEXT AS "source"
      FROM
        "Transactions" t
      LEFT JOIN "Collectives" h ON
        t."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        t."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month', date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month', date :date)
        AND t."deletedAt" IS NULL
        AND t."type" = 'CREDIT'
        AND t."platformFeeInHostCurrency" != 0
        AND (
          pm."service" != 'stripe'
          OR pm.service IS NULL
        )
        AND (
          spm.service IS NULL
          OR spm.service != 'stripe'
        )
        AND (h."type" = 'ORGANIZATION' AND h."isActive" = TRUE AND h."isHostAccount")
      ORDER BY
        t."createdAt"
    )

    SELECT
      *
    FROM
      "platformFees"
    UNION
    SELECT
      *
    FROM
      "platformTips";
  `,
    { replacements: { date: date.format('L') } },
  );
  const byHost = groupBy(pastMonthTransactions, 'HostCollectiveId');
  const today = moment.utc();

  for (const [hostId, hostTransactions] of entries(byHost)) {
    const { HostName, currency } = hostTransactions[0];

    let items = entries(groupBy(hostTransactions, 'source')).map(([source, transactions]) => ({
      incurredAt: date,
      amount: round(sumBy(transactions, 'amount')),
      description: `${source}s`,
    }));

    const transactionIds = hostTransactions.map(t => t.id);
    const totalAmount = sumBy(items, i => i.amount);
    console.info(
      `Host ${HostName} (#${hostId}) has ${hostTransactions.length} pending transactions and owes ${
        totalAmount / 100
      } (${currency})`,
    );

    // Credit the Host with platform tips collected during the month
    await models.Transaction.create({
      amount: totalAmount,
      amountInHostCurrency: totalAmount,
      CollectiveId: hostId,
      // Pia's account
      CreatedByUserId: 30,
      currency: currency,
      description: `Platform Fees and Tips collected in ${moment.utc().subtract(1, 'month').format('MMMM')}`,
      FromCollectiveId: FEES_ON_TOP_SETTLEMENT_EXPENSE_PROPERTIES.FromCollectiveId,
      HostCollectiveId: hostId,
      hostCurrency: currency,
      netAmountInCollectiveCurrency: totalAmount,
      type: TransactionTypes.CREDIT,
    });

    const host = await models.Collective.findByPk(hostId);
    const connectedAccounts = await host.getConnectedAccounts({
      where: { deletedAt: null },
    });

    let PayoutMethodId = FEES_ON_TOP_SETTLEMENT_EXPENSE_PROPERTIES.PayoutMethodId;
    if (connectedAccounts?.find?.(c => c.service === 'transferwise')) {
      PayoutMethodId = 2955;
    } else if (connectedAccounts?.find?.(c => c.service === 'paypal') && !host.settings?.disablePaypalPayouts) {
      PayoutMethodId = 6087;
    }

    // Create the Expense
    const expense = await models.Expense.create({
      ...FEES_ON_TOP_SETTLEMENT_EXPENSE_PROPERTIES,
      PayoutMethodId,
      amount: totalAmount,
      CollectiveId: hostId,
      currency: currency,
      description: `Platform settlement for ${moment.utc().subtract(1, 'month').format('MMMM')}`,
      incurredAt: today,
      data: { isPlatformTipSettlement: true, transactionIds },
      type: expenseTypes.INVOICE,
      status: expenseStatus.APPROVED,
    });

    // Create Expense Items
    items = items.map(i => ({
      ...i,
      ExpenseId: expense.id,
      CreatedByUserId: FEES_ON_TOP_SETTLEMENT_EXPENSE_PROPERTIES.UserId,
    }));
    await models.ExpenseItem.bulkCreate(items);

    // Attach CSV
    const Body = json2csv(hostTransactions.map(t => omit(t, ['data'])));
    const filenameBase = `${HostName}-${moment(date).subtract(1, 'month').format('MMMM-YYYY')}`;
    const Key = `${filenameBase}.${generateKey().slice(0, 6)}.csv`;
    const { Location: url } = await uploadToS3({
      Bucket: config.aws.s3.bucket,
      Key,
      Body,
      ACL: 'public-read',
      ContentType: 'text/csv',
    });
    await models.ExpenseAttachedFile.create({
      url,
      ExpenseId: expense.id,
      CreatedByUserId: FEES_ON_TOP_SETTLEMENT_EXPENSE_PROPERTIES.UserId,
    });
  }
}

if (require.main === module) {
  run()
    .catch(e => {
      console.error(e);
      process.exit(1);
    })
    .then(() => {
      process.exit();
    });
}
