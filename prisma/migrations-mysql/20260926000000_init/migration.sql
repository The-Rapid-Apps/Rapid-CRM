-- CreateTable
CREATE TABLE `organizations` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `logoSnapshotSyncedAt` DATETIME(3) NULL,
    `logoSnapshotBackfillCursor` DATETIME(3) NULL,
    `logoSnapshotBackfillCompletedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `name` VARCHAR(191) NULL,
    `role` ENUM('ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `deactivatedAt` DATETIME(3) NULL,
    `sessionsValidFrom` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_invites` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `role` ENUM('ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `tokenHash` VARCHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `invitedById` VARCHAR(191) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `user_invites_tokenHash_key`(`tokenHash`),
    INDEX `user_invites_organizationId_acceptedAt_revokedAt_expiresAt_idx`(`organizationId`, `acceptedAt`, `revokedAt`, `expiresAt`),
    INDEX `user_invites_email_idx`(`email`),
    INDEX `user_invites_invitedById_idx`(`invitedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `apps` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `handle` VARCHAR(191) NOT NULL,
    `logoUrl` VARCHAR(512) NULL,
    `appStoreHandle` VARCHAR(191) NULL,
    `reviewsSyncedAt` DATETIME(3) NULL,
    `reviewsBackfillNextPage` INTEGER NULL,
    `reviewsBackfillCompletedAt` DATETIME(3) NULL,
    `reviewsSweepStartedAt` DATETIME(3) NULL,
    `appStoreRating` DECIMAL(3, 2) NULL,
    `appStoreReviewCount` INTEGER NULL,
    `isProduction` BOOLEAN NOT NULL DEFAULT true,
    `shopifyApiKey` VARCHAR(191) NOT NULL,
    `shopifyApiSecret` VARCHAR(191) NOT NULL,
    `shopifyAppId` VARCHAR(191) NULL,
    `distribution` ENUM('PUBLIC', 'PRIVATE') NOT NULL DEFAULT 'PUBLIC',
    `partnerApiToken` VARCHAR(191) NULL,
    `partnerOrganizationId` VARCHAR(191) NULL,
    `partnerConnectionId` VARCHAR(191) NULL,
    `partnerAppVerifiedAt` DATETIME(3) NULL,
    `partnerAppVerificationError` TEXT NULL,
    `lifecycleEventsSyncedAt` DATETIME(3) NULL,
    `lifecycleEventsIncrementalCursor` TEXT NULL,
    `lifecycleEventsIncrementalMinAt` DATETIME(3) NULL,
    `lifecycleEventsIncrementalMaxAt` DATETIME(3) NULL,
    `lifecycleEventsBackfillCursor` TEXT NULL,
    `lifecycleEventsBackfillMaxAt` DATETIME(3) NULL,
    `lifecycleEventsBackfillCompletedAt` DATETIME(3) NULL,
    `lifecycleSyncLeaseToken` VARCHAR(191) NULL,
    `lifecycleSyncLeaseExpiresAt` DATETIME(3) NULL,
    `lifecycleDeriveLeaseToken` VARCHAR(191) NULL,
    `lifecycleDeriveLeaseExpiresAt` DATETIME(3) NULL,
    `billingEventsSyncedAt` DATETIME(3) NULL,
    `billingEventsIncrementalCursor` TEXT NULL,
    `billingEventsIncrementalMinAt` DATETIME(3) NULL,
    `billingEventsIncrementalMaxAt` DATETIME(3) NULL,
    `billingEventsBackfillCursor` TEXT NULL,
    `billingEventsBackfillMaxAt` DATETIME(3) NULL,
    `billingEventsBackfillCompletedAt` DATETIME(3) NULL,
    `billingSalesSyncedAt` DATETIME(3) NULL,
    `billingSalesIncrementalCursor` TEXT NULL,
    `billingSalesIncrementalMinAt` DATETIME(3) NULL,
    `billingSalesIncrementalMaxAt` DATETIME(3) NULL,
    `billingSalesBackfillCursor` TEXT NULL,
    `billingSalesBackfillMaxAt` DATETIME(3) NULL,
    `billingSalesBackfillCompletedAt` DATETIME(3) NULL,
    `mrrSnapshotSyncedAt` DATETIME(3) NULL,
    `mrrSnapshotBackfillCursor` DATETIME(3) NULL,
    `mrrSnapshotBackfillCompletedAt` DATETIME(3) NULL,
    `mrrSnapshotDirtyFrom` DATETIME(3) NULL,
    `logoSnapshotDirtyFrom` DATETIME(3) NULL,
    `installSnapshotSyncedAt` DATETIME(3) NULL,
    `installSnapshotFloorDate` DATETIME(3) NULL,
    `installSnapshotBackfillCursor` DATETIME(3) NULL,
    `installSnapshotBackfillCompletedAt` DATETIME(3) NULL,
    `installSnapshotDirtyFrom` DATETIME(3) NULL,
    `billingSyncLeaseToken` VARCHAR(191) NULL,
    `billingSyncLeaseExpiresAt` DATETIME(3) NULL,
    `partnerStateBackfillCursor` VARCHAR(191) NULL,
    `partnerStateBackfillCompletedAt` DATETIME(3) NULL,
    `partnerStateInstallBackfillCursor` VARCHAR(191) NULL,
    `partnerStateInstallBackfillCompletedAt` DATETIME(3) NULL,
    `ga4PropertyId` VARCHAR(191) NULL,
    `bigqueryDataset` VARCHAR(191) NULL,
    `gcpProjectId` VARCHAR(191) NULL,
    `trafficEventsSyncedAt` DATETIME(3) NULL,
    `trafficEventsBackfillCursor` DATETIME(3) NULL,
    `trafficEventsBackfillCompletedAt` DATETIME(3) NULL,
    `trafficEventsSyncLeaseToken` VARCHAR(191) NULL,
    `trafficEventsSyncLeaseExpiresAt` DATETIME(3) NULL,
    `apiKey` VARCHAR(191) NOT NULL,
    `apiKeyHash` VARCHAR(64) NULL,
    `apiKeyCipher` TEXT NULL,
    `apiSecretHash` VARCHAR(191) NULL,
    `disableDowngradeCredits` BOOLEAN NOT NULL DEFAULT false,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `removed` BOOLEAN NOT NULL DEFAULT false,
    `scheduledForDeletionAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `apps_handle_key`(`handle`),
    UNIQUE INDEX `apps_apiKey_key`(`apiKey`),
    UNIQUE INDEX `apps_apiKeyHash_key`(`apiKeyHash`),
    INDEX `apps_organizationId_idx`(`organizationId`),
    INDEX `apps_partnerConnectionId_idx`(`partnerConnectionId`),
    INDEX `apps_lifecycleSyncLeaseExpiresAt_idx`(`lifecycleSyncLeaseExpiresAt`),
    INDEX `apps_lifecycleDeriveLeaseExpiresAt_idx`(`lifecycleDeriveLeaseExpiresAt`),
    INDEX `apps_billingSyncLeaseExpiresAt_idx`(`billingSyncLeaseExpiresAt`),
    INDEX `apps_trafficEventsSyncLeaseExpiresAt_idx`(`trafficEventsSyncLeaseExpiresAt`),
    UNIQUE INDEX `apps_organizationId_shopifyAppId_key`(`organizationId`, `shopifyAppId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shop_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `shopDomain` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NULL,
    `shopifyPlan` VARCHAR(64) NULL,
    `countryCode` VARCHAR(8) NULL,
    `source` VARCHAR(32) NOT NULL,
    `asOf` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `shop_profiles_shopDomain_key`(`shopDomain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_reviews` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `platformReviewId` VARCHAR(64) NOT NULL,
    `rating` INTEGER NOT NULL,
    `body` TEXT NOT NULL,
    `reviewerName` VARCHAR(255) NOT NULL,
    `reviewerCountry` VARCHAR(191) NULL,
    `timeUsingApp` VARCHAR(191) NULL,
    `replyBody` TEXT NULL,
    `reviewedAt` DATETIME(3) NOT NULL,
    `edited` BOOLEAN NOT NULL DEFAULT false,
    `archivedAt` DATETIME(3) NULL,
    `shopDomain` VARCHAR(255) NULL,
    `importedFrom` VARCHAR(32) NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `app_reviews_appId_reviewedAt_idx`(`appId`, `reviewedAt`),
    INDEX `app_reviews_reviewedAt_idx`(`reviewedAt`),
    UNIQUE INDEX `app_reviews_appId_platformReviewId_key`(`appId`, `platformReviewId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `traffic_saved_filters` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `dimensions` TEXT NOT NULL,
    `funnelEvents` TEXT NOT NULL,
    `filters` TEXT NOT NULL,
    `appId` VARCHAR(191) NULL,
    `period` VARCHAR(191) NULL,
    `dateStart` DATETIME(3) NULL,
    `dateEnd` DATETIME(3) NULL,
    `compareMode` VARCHAR(191) NULL,
    `compareStart` DATETIME(3) NULL,
    `compareEnd` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `traffic_saved_filters_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `saved_report_views` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `report` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `state` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `saved_report_views_organizationId_report_idx`(`organizationId`, `report`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `traffic_event_facts` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(64) NOT NULL,
    `eventName` VARCHAR(32) NOT NULL,
    `eventDate` DATETIME(3) NOT NULL,
    `eventTimestamp` DATETIME(3) NOT NULL,
    `userPseudoId` VARCHAR(191) NOT NULL,
    `shopUrl` VARCHAR(255) NULL,
    `pageLocation` TEXT NULL,
    `pageReferrer` TEXT NULL,
    `campaign` VARCHAR(191) NULL,
    `trafficSourceName` VARCHAR(191) NULL,
    `trafficSourceMedium` VARCHAR(191) NULL,
    `trafficSourceSource` VARCHAR(191) NULL,
    `language` VARCHAR(32) NULL,
    `country` VARCHAR(191) NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `traffic_event_facts_dedupeKey_key`(`dedupeKey`),
    INDEX `traffic_event_fact_app_event_date_idx`(`appId`, `eventName`, `eventDate`),
    INDEX `traffic_event_fact_app_user_ts_idx`(`appId`, `userPseudoId`, `eventTimestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_subscription_events` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(64) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `shopDomain` VARCHAR(255) NOT NULL,
    `shopPlatformId` VARCHAR(191) NULL,
    `chargePlatformId` VARCHAR(191) NOT NULL,
    `chargeName` VARCHAR(255) NOT NULL,
    `amount` DECIMAL(18, 6) NOT NULL,
    `currencyCode` VARCHAR(3) NOT NULL,
    `billingOn` DATETIME(3) NULL,
    `test` BOOLEAN NOT NULL DEFAULT false,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `partner_subscription_events_dedupeKey_key`(`dedupeKey`),
    INDEX `partner_sub_event_app_occurred_idx`(`appId`, `occurredAt`),
    INDEX `partner_sub_event_charge_occurred_idx`(`appId`, `chargePlatformId`, `occurredAt`),
    INDEX `partner_sub_event_app_shop_idx`(`appId`, `shopDomain`),
    INDEX `partner_sub_event_app_billing_on_idx`(`appId`, `billingOn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_subscription_sale_facts` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `transactionPlatformId` VARCHAR(191) NOT NULL,
    `chargePlatformId` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `shopDomain` VARCHAR(255) NULL,
    `shopPlatformId` VARCHAR(191) NULL,
    `billingInterval` VARCHAR(32) NULL,
    `grossAmount` DECIMAL(18, 6) NULL,
    `netAmount` DECIMAL(18, 6) NULL,
    `shopifyFee` DECIMAL(18, 6) NULL,
    `currencyCode` VARCHAR(3) NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `partner_subscription_sale_facts_transactionPlatformId_key`(`transactionPlatformId`),
    INDEX `partner_sub_sale_app_occurred_idx`(`appId`, `occurredAt`),
    INDEX `partner_sub_sale_charge_occurred_idx`(`appId`, `chargePlatformId`, `occurredAt`),
    INDEX `partner_sub_sale_app_shop_idx`(`appId`, `shopDomain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_subscription_states` (
    `appId` VARCHAR(191) NOT NULL,
    `chargePlatformId` VARCHAR(191) NOT NULL,
    `shopDomain` VARCHAR(255) NOT NULL,
    `chargeName` VARCHAR(255) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `amount` DECIMAL(18, 6) NOT NULL,
    `approvedAmount` DECIMAL(18, 6) NOT NULL,
    `currencyCode` VARCHAR(3) NOT NULL,
    `billingInterval` VARCHAR(32) NULL,
    `nextBillingOn` DATETIME(3) NULL,
    `lastEventAt` DATETIME(3) NOT NULL,
    `lastEventType` VARCHAR(64) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `partner_sub_state_app_status_idx`(`appId`, `status`, `lastEventAt`),
    INDEX `partner_sub_state_app_shop_idx`(`appId`, `shopDomain`),
    PRIMARY KEY (`appId`, `chargePlatformId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_customer_states` (
    `appId` VARCHAR(191) NOT NULL,
    `shopDomain` VARCHAR(255) NOT NULL,
    `firstSeen` DATETIME(3) NOT NULL,
    `lastActivity` DATETIME(3) NOT NULL,
    `activeChargeCount` INTEGER NOT NULL,
    `attentionChargeCount` INTEGER NOT NULL,
    `mrr` DECIMAL(18, 6) NOT NULL,
    `currencyCode` VARCHAR(3) NOT NULL,
    `lifetimeValue` DECIMAL(18, 6) NOT NULL,
    `saleCount` INTEGER NOT NULL,
    `oauthConnected` BOOLEAN NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `partner_customer_state_app_activity_idx`(`appId`, `lastActivity`),
    PRIMARY KEY (`appId`, `shopDomain`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_comments` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `shopDomain` VARCHAR(255) NOT NULL,
    `authorUserId` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `customer_comments_organizationId_shopDomain_createdAt_idx`(`organizationId`, `shopDomain`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_daily_mrr_snapshots` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `snapshotDate` DATETIME(3) NOT NULL,
    `currencyCode` VARCHAR(3) NOT NULL,
    `mrr` DECIMAL(18, 6) NOT NULL,
    `arr` DECIMAL(18, 6) NOT NULL,
    `monthlySubscriptions` DECIMAL(18, 6) NOT NULL,
    `annualSubscriptions` DECIMAL(18, 6) NOT NULL,
    `trialSubscriptions` DECIMAL(18, 6) NOT NULL,
    `usageCharges` DECIMAL(18, 6) NOT NULL,
    `activeSubscriptions` INTEGER NOT NULL,
    `revenueGross` DECIMAL(18, 6) NOT NULL,
    `revenueCredits` DECIMAL(18, 6) NOT NULL,
    `revenueNet` DECIMAL(18, 6) NOT NULL,
    `subscriptionChurnedCount` INTEGER NOT NULL,
    `subscriptionRecoveredCount` INTEGER NOT NULL,
    `churnedRevenueLost` DECIMAL(18, 6) NOT NULL,
    `mrrNew` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `mrrReactivation` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `mrrExpansion` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `mrrContraction` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `mrrChurn` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `mrrFrozen` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `mrrUnfrozen` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `mrrEarlyPlanChange` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `builtFromEventsSyncedAt` DATETIME(3) NULL,
    `builtFromSalesSyncedAt` DATETIME(3) NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `partner_daily_mrr_snapshot_app_date_idx`(`appId`, `snapshotDate`),
    UNIQUE INDEX `partner_daily_mrr_snapshot_app_date_ccy_key`(`appId`, `snapshotDate`, `currencyCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_daily_plan_mrr_snapshots` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `snapshotDate` DATETIME(3) NOT NULL,
    `currencyCode` VARCHAR(3) NOT NULL,
    `plan` VARCHAR(255) NOT NULL,
    `mrr` DECIMAL(18, 6) NOT NULL,
    `activeSubscriptions` INTEGER NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `partner_daily_plan_mrr_snapshot_app_date_idx`(`appId`, `snapshotDate`),
    UNIQUE INDEX `partner_daily_plan_mrr_snapshot_app_date_ccy_plan_key`(`appId`, `snapshotDate`, `currencyCode`, `plan`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_offer_cadence_inferences` (
    `appId` VARCHAR(191) NOT NULL,
    `chargeName` VARCHAR(255) NOT NULL,
    `amount` DECIMAL(18, 6) NOT NULL,
    `interval` VARCHAR(32) NULL,
    `effectiveAmount` DECIMAL(18, 6) NULL,
    `pinnedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`appId`, `chargeName`, `amount`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_charge_live_discount_checks` (
    `appId` VARCHAR(191) NOT NULL,
    `chargePlatformId` VARCHAR(191) NOT NULL,
    `effectiveAmount` DECIMAL(18, 6) NULL,
    `discountPercentage` DOUBLE NULL,
    `discountEndsAt` DATETIME(3) NULL,
    `remainingDiscountCycles` INTEGER NULL,
    `subscriptionActive` BOOLEAN NOT NULL DEFAULT true,
    `trialEndsAt` DATETIME(3) NULL,
    `cancelAtEndOfCycle` BOOLEAN NULL,
    `currentCycleStart` DATETIME(3) NULL,
    `currentCycleEnd` DATETIME(3) NULL,
    `usageCost` DECIMAL(18, 6) NULL,
    `usageQuantity` DOUBLE NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`appId`, `chargePlatformId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_daily_logo_churn_snapshots` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `snapshotDate` DATETIME(3) NOT NULL,
    `activeShops` INTEGER NOT NULL,
    `churnedShops` INTEGER NOT NULL,
    `recoveredShops` INTEGER NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `partner_daily_logo_churn_snapshot_org_app_date_idx`(`organizationId`, `appId`, `snapshotDate`),
    UNIQUE INDEX `partner_daily_logo_churn_snapshot_org_app_date_key`(`organizationId`, `appId`, `snapshotDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_daily_install_snapshots` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `snapshotDate` DATETIME(3) NOT NULL,
    `activeInstallsAtDayStart` INTEGER NOT NULL,
    `activeInstallsAtDayEnd` INTEGER NOT NULL,
    `newInstalls` INTEGER NOT NULL,
    `uninstallsAll` INTEGER NOT NULL,
    `logoLost` INTEGER NOT NULL,
    `logoRecovered` INTEGER NOT NULL,
    `reactivations` INTEGER NOT NULL,
    `deactivations` INTEGER NOT NULL,
    `builtFromLifecycleSyncedAt` DATETIME(3) NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `partner_daily_install_snapshot_app_date_idx`(`appId`, `snapshotDate`),
    UNIQUE INDEX `partner_daily_install_snapshot_app_date_key`(`appId`, `snapshotDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shopify_partner_connections` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `partnerOrganizationId` VARCHAR(191) NOT NULL,
    `encryptedAccessToken` TEXT NOT NULL,
    `tokenLastFour` VARCHAR(191) NOT NULL,
    `status` ENUM('UNTESTED', 'CONNECTED', 'ERROR') NOT NULL DEFAULT 'UNTESTED',
    `lastTestedAt` DATETIME(3) NULL,
    `lastConnectedAt` DATETIME(3) NULL,
    `lastErrorCode` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `shopify_partner_connections_organizationId_idx`(`organizationId`),
    UNIQUE INDEX `shopify_partner_connections_organizationId_partnerOrganizati_key`(`organizationId`, `partnerOrganizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_installs` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `shopDomain` VARCHAR(191) NOT NULL,
    `shopPlatformId` VARCHAR(191) NULL,
    `accessToken` VARCHAR(191) NULL,
    `scope` VARCHAR(191) NULL,
    `shopName` VARCHAR(255) NULL,
    `installedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `uninstalledAt` DATETIME(3) NULL,
    `relationshipStateSyncedAt` DATETIME(3) NULL,
    `trialConsumedAt` DATETIME(3) NULL,

    INDEX `app_installs_appId_idx`(`appId`),
    INDEX `app_installs_appId_installedAt_idx`(`appId`, `installedAt`),
    INDEX `app_installs_appId_uninstalledAt_idx`(`appId`, `uninstalledAt`),
    UNIQUE INDEX `app_installs_appId_shopDomain_key`(`appId`, `shopDomain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `raw_partner_events` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `shopDomain` VARCHAR(191) NOT NULL,
    `shopPlatformId` VARCHAR(191) NULL,
    `shopName` VARCHAR(255) NULL,
    `reason` TEXT NULL,
    `description` LONGTEXT NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `raw_partner_events_appId_occurredAt_idx`(`appId`, `occurredAt`),
    UNIQUE INDEX `raw_partner_events_appId_type_occurredAt_shopDomain_key`(`appId`, `type`, `occurredAt`, `shopDomain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `account_lifecycle_events` (
    `id` VARCHAR(191) NOT NULL,
    `appInstallId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `type` ENUM('INSTALLED', 'REINSTALLED', 'UNINSTALLED', 'REACTIVATED', 'DEACTIVATED') NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `platformEventId` VARCHAR(191) NOT NULL,
    `rawPartnerEventId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `account_lifecycle_events_platformEventId_key`(`platformEventId`),
    UNIQUE INDEX `account_lifecycle_events_rawPartnerEventId_key`(`rawPartnerEventId`),
    INDEX `account_lifecycle_events_appInstallId_occurredAt_idx`(`appInstallId`, `occurredAt`),
    INDEX `account_lifecycle_events_type_occurredAt_idx`(`type`, `occurredAt`),
    INDEX `account_lifecycle_events_app_occurred_idx`(`appId`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `uninstall_event_details` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `reason` TEXT NULL,
    `description` LONGTEXT NULL,
    `reasonCode` VARCHAR(191) NOT NULL,
    `reasonCodes` JSON NOT NULL,
    `isStoreClosure` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uninstall_event_details_eventId_key`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plans` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `amount` DECIMAL(18, 6) NOT NULL,
    `currencyCode` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `interval` ENUM('EVERY_30_DAYS', 'ANNUAL', 'QUARTERLY') NOT NULL DEFAULT 'EVERY_30_DAYS',
    `recurringInterval` ENUM('DAY', 'WEEK', 'MONTH', 'YEAR') NOT NULL DEFAULT 'MONTH',
    `recurringIntervalCount` INTEGER NOT NULL DEFAULT 1,
    `flexBilling` BOOLEAN NOT NULL DEFAULT true,
    `usageBilling` BOOLEAN NOT NULL DEFAULT false,
    `usageChargeCappedAmount` DECIMAL(18, 6) NOT NULL,
    `flexBillingTerms` VARCHAR(191) NOT NULL DEFAULT 'Flexible usage-based billing',
    `trialDays` INTEGER NOT NULL DEFAULT 0,
    `chargeUsageDuringTrial` BOOLEAN NOT NULL DEFAULT false,
    `onUsageLimitReached` ENUM('NONE', 'UPGRADE') NOT NULL DEFAULT 'NONE',
    `autoUpgradeToPlanId` VARCHAR(191) NULL,
    `limitMetric` VARCHAR(191) NULL,
    `limitMin` DECIMAL(18, 6) NULL,
    `limitMax` DECIMAL(18, 6) NULL,
    `usageLimitsPeriod` ENUM('MONTH_TO_DATE', 'CURRENT_BILLING_PERIOD') NOT NULL DEFAULT 'CURRENT_BILLING_PERIOD',
    `revenueCapLimit` DECIMAL(18, 6) NULL,
    `revenueCapPeriod` ENUM('BILLING_PERIOD', 'LIFETIME') NOT NULL DEFAULT 'BILLING_PERIOD',
    `active` BOOLEAN NOT NULL DEFAULT true,
    `isPublic` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `plans_appId_idx`(`appId`),
    INDEX `plans_autoUpgradeToPlanId_idx`(`autoUpgradeToPlanId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_features` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `type` ENUM('BOOLEAN', 'LIMIT', 'LIMIT_WITH_OVERAGE', 'STRING') NOT NULL DEFAULT 'BOOLEAN',
    `defaultValue` VARCHAR(191) NOT NULL,
    `visibleToCustomers` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `plan_features_appId_sortOrder_idx`(`appId`, `sortOrder`),
    UNIQUE INDEX `plan_features_appId_key_key`(`appId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_feature_entitlements` (
    `id` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `featureId` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `trialValue` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `plan_feature_entitlements_featureId_idx`(`featureId`),
    UNIQUE INDEX `plan_feature_entitlements_planId_featureId_key`(`planId`, `featureId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscriptions` (
    `id` VARCHAR(191) NOT NULL,
    `appInstallId` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `billingProvider` ENUM('SHOPIFY') NOT NULL DEFAULT 'SHOPIFY',
    `status` ENUM('PENDING', 'ACTIVE', 'FROZEN', 'CANCELLED', 'DECLINED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `test` BOOLEAN NOT NULL DEFAULT false,
    `activatedAt` DATETIME(3) NULL,
    `canceledAt` DATETIME(3) NULL,
    `frozenAt` DATETIME(3) NULL,
    `pausedUntil` DATETIME(3) NULL,
    `currentPeriodStart` DATETIME(3) NULL,
    `currentPeriodEnd` DATETIME(3) NULL,
    `nextBillingDate` DATETIME(3) NULL,
    `billingCycleAnchor` DATETIME(3) NULL,
    `shopifySubscriptionId` VARCHAR(191) NULL,
    `usageLineItemId` VARCHAR(191) NULL,
    `trialStartedAt` DATETIME(3) NULL,
    `trialEndsAt` DATETIME(3) NULL,
    `triggeredByUsageChargeId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `confirmationUrl` TEXT NULL,
    `approvalExpiresAt` DATETIME(3) NULL,
    `replacesSubscriptionId` VARCHAR(191) NULL,
    `replacementEventId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `subscriptions_idempotencyKey_key`(`idempotencyKey`),
    INDEX `subscriptions_appInstallId_idx`(`appInstallId`),
    INDEX `subscriptions_planId_idx`(`planId`),
    INDEX `subscriptions_replacesSubscriptionId_idx`(`replacesSubscriptionId`),
    INDEX `subscriptions_activatedAt_canceledAt_idx`(`activatedAt`, `canceledAt`),
    INDEX `subscriptions_billingProvider_nextBillingDate_idx`(`billingProvider`, `nextBillingDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscription_line_items` (
    `id` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NOT NULL,
    `type` ENUM('SUBSCRIPTION', 'USAGE', 'ADDON') NOT NULL,
    `key` VARCHAR(191) NOT NULL DEFAULT 'default',
    `platformId` VARCHAR(191) NULL,
    `cappedAmount` DECIMAL(18, 6) NULL,
    `amount` DECIMAL(18, 6) NULL,
    `currencyCode` VARCHAR(3) NULL,
    `balanceUsed` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `currentPeriodBilledSpend` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `spendPeriodStart` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `subscription_line_items_subscriptionId_idx`(`subscriptionId`),
    UNIQUE INDEX `subscription_line_items_subscriptionId_type_key_key`(`subscriptionId`, `type`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `charges` (
    `id` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 6) NOT NULL,
    `chargedAmount` DECIMAL(18, 6) NOT NULL,
    `chargedCurrencyCode` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `platformId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `isCredit` BOOLEAN NOT NULL DEFAULT false,
    `flexBilling` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('PENDING', 'ACTIVE', 'DECLINED', 'FAILED') NOT NULL DEFAULT 'ACTIVE',
    `description` VARCHAR(191) NULL,
    `billingPeriodStart` DATETIME(3) NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `charges_idempotencyKey_key`(`idempotencyKey`),
    INDEX `charges_subscriptionId_idx`(`subscriptionId`),
    INDEX `charges_subscriptionId_flexBilling_isCredit_occurredAt_idx`(`subscriptionId`, `flexBilling`, `isCredit`, `occurredAt`),
    INDEX `charges_status_occurredAt_idx`(`status`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_one_time_purchases` (
    `id` VARCHAR(191) NOT NULL,
    `appInstallId` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 6) NOT NULL,
    `currencyCode` VARCHAR(3) NOT NULL DEFAULT 'USD',
    `platformId` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'DECLINED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `confirmationUrl` TEXT NULL,
    `test` BOOLEAN NOT NULL DEFAULT false,
    `idempotencyKey` VARCHAR(191) NULL,
    `approvalExpiresAt` DATETIME(3) NULL,
    `activatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `app_one_time_purchases_platformId_key`(`platformId`),
    UNIQUE INDEX `app_one_time_purchases_idempotencyKey_key`(`idempotencyKey`),
    INDEX `app_one_time_purchases_appInstallId_createdAt_idx`(`appInstallId`, `createdAt`),
    INDEX `app_one_time_purchases_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `discounts` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `orgCodeKey` VARCHAR(191) NULL,
    `planId` VARCHAR(191) NULL,
    `externalPlanKey` VARCHAR(191) NULL,
    `code` VARCHAR(191) NULL,
    `normalizedCode` VARCHAR(191) NULL,
    `type` ENUM('PERCENTAGE', 'AMOUNT', 'FLAT_PRICE') NOT NULL DEFAULT 'PERCENTAGE',
    `value` DECIMAL(18, 6) NOT NULL,
    `discountMethod` ENUM('PRICE_REDUCTION', 'APP_CREDITS') NOT NULL DEFAULT 'PRICE_REDUCTION',
    `durationIntervals` INTEGER NULL,
    `currencyCode` VARCHAR(3) NULL,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `maxRedemptions` INTEGER NULL,
    `maxRedemptionsPerShop` INTEGER NULL,
    `description` VARCHAR(191) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `discounts_organizationId_idx`(`organizationId`),
    INDEX `discounts_appId_idx`(`appId`),
    INDEX `discounts_appId_externalPlanKey_idx`(`appId`, `externalPlanKey`),
    INDEX `discounts_code_idx`(`code`),
    UNIQUE INDEX `discounts_appId_normalizedCode_key`(`appId`, `normalizedCode`),
    UNIQUE INDEX `discounts_organizationId_orgCodeKey_key`(`organizationId`, `orgCodeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `discount_apps` (
    `discountId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `discount_apps_appId_idx`(`appId`),
    PRIMARY KEY (`discountId`, `appId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `discount_redemptions` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `discountId` VARCHAR(191) NOT NULL,
    `shopDomain` VARCHAR(255) NOT NULL,
    `externalPlanKey` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `status` ENUM('RESERVED', 'APPLIED', 'RELEASED') NOT NULL DEFAULT 'RESERVED',
    `listPrice` DECIMAL(18, 6) NOT NULL,
    `priceAfterDiscount` DECIMAL(18, 6) NOT NULL,
    `currencyCode` VARCHAR(3) NOT NULL,
    `discountType` ENUM('PERCENTAGE', 'AMOUNT', 'FLAT_PRICE') NOT NULL,
    `discountValue` DECIMAL(18, 6) NOT NULL,
    `durationIntervals` INTEGER NULL,
    `shopifyPercentage` DECIMAL(10, 6) NULL,
    `shopifyAmount` DECIMAL(18, 6) NULL,
    `shopifySubscriptionId` VARCHAR(191) NULL,
    `reservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `appliedAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `discount_redemptions_shopifySubscriptionId_key`(`shopifySubscriptionId`),
    INDEX `discount_redemptions_discountId_status_expiresAt_idx`(`discountId`, `status`, `expiresAt`),
    INDEX `discount_redemptions_appId_shopDomain_status_idx`(`appId`, `shopDomain`, `status`),
    UNIQUE INDEX `discount_redemptions_appId_idempotencyKey_key`(`appId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_rate_limit_buckets` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `routeKey` VARCHAR(64) NOT NULL,
    `windowStart` DATETIME(3) NOT NULL,
    `requestCount` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `api_rate_limit_buckets_updatedAt_idx`(`updatedAt`),
    UNIQUE INDEX `api_rate_limit_buckets_appId_routeKey_windowStart_key`(`appId`, `routeKey`, `windowStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_request_logs` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NULL,
    `requestId` VARCHAR(64) NOT NULL,
    `method` VARCHAR(10) NOT NULL,
    `path` VARCHAR(500) NOT NULL,
    `query` TEXT NULL,
    `status` INTEGER NOT NULL,
    `durationMs` DECIMAL(12, 3) NOT NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` TEXT NULL,
    `customer` VARCHAR(255) NULL,
    `requestHeaders` JSON NULL,
    `requestBody` JSON NULL,
    `responseHeaders` JSON NULL,
    `responseBody` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `api_request_logs_requestId_key`(`requestId`),
    INDEX `api_request_logs_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `api_request_logs_organizationId_method_status_createdAt_idx`(`organizationId`, `method`, `status`, `createdAt`),
    INDEX `api_request_logs_organizationId_customer_createdAt_idx`(`organizationId`, `customer`, `createdAt`),
    INDEX `api_request_logs_appId_createdAt_idx`(`appId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscription_discounts` (
    `id` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NOT NULL,
    `discountId` VARCHAR(191) NOT NULL,
    `startsAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endsAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `subscription_discounts_subscriptionId_idx`(`subscriptionId`),
    INDEX `subscription_discounts_discountId_idx`(`discountId`),
    UNIQUE INDEX `subscription_discounts_subscriptionId_discountId_key`(`subscriptionId`, `discountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `usage_events` (
    `id` VARCHAR(191) NOT NULL,
    `appInstallId` VARCHAR(191) NOT NULL,
    `metric` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(18, 6) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `idempotencyKey` VARCHAR(191) NULL,

    UNIQUE INDEX `usage_events_idempotencyKey_key`(`idempotencyKey`),
    INDEX `usage_events_appInstallId_metric_occurredAt_idx`(`appInstallId`, `metric`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `flex_billing_events` (
    `id` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NULL,
    `previousSubscriptionId` VARCHAR(191) NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `type` ENUM('SUBSCRIBED', 'SUBSCRIPTION_CHARGED', 'UPGRADED', 'DOWNGRADED') NOT NULL,
    `amount` DECIMAL(18, 6) NULL,
    `currencyCode` VARCHAR(191) NULL,
    `interval` VARCHAR(191) NULL,
    `test` BOOLEAN NULL,
    `proration` BOOLEAN NOT NULL DEFAULT false,
    `prorationAmount` DECIMAL(18, 6) NULL,
    `prorationAmountCurrency` VARCHAR(191) NULL,
    `prorationPlatformId` VARCHAR(191) NULL,
    `prorationCompletedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `minutesOnPlanBeforeChange` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `flex_billing_events_organizationId_date_idx`(`organizationId`, `date`),
    INDEX `flex_billing_events_subscriptionId_idx`(`subscriptionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `flex_locks` (
    `key` VARCHAR(191) NOT NULL,
    `owner` VARCHAR(191) NOT NULL,
    `lockedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `flex_locks_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `identified_customers` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(64) NOT NULL,
    `platformId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NULL,
    `email` VARCHAR(320) NULL,
    `myshopifyDomain` VARCHAR(255) NULL,
    `accessToken` TEXT NULL,
    `customFields` JSON NULL,
    `apiToken` VARCHAR(255) NOT NULL,
    `apiTokenHash` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `identified_customers_apiTokenHash_key`(`apiTokenHash`),
    UNIQUE INDEX `identified_customers_appId_platform_platformId_key`(`appId`, `platform`, `platformId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `identify_api_keys` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `secretCipher` TEXT NULL,
    `prefix` VARCHAR(32) NOT NULL,
    `last4` VARCHAR(8) NOT NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `identify_api_keys_tokenHash_key`(`tokenHash`),
    INDEX `identify_api_keys_appId_revokedAt_createdAt_idx`(`appId`, `revokedAt`, `createdAt`),
    INDEX `identify_api_keys_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `identify_rate_limit_buckets` (
    `id` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `routeKey` VARCHAR(64) NOT NULL,
    `windowStart` DATETIME(3) NOT NULL,
    `requestCount` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `identify_rate_limit_buckets_updatedAt_idx`(`updatedAt`),
    UNIQUE INDEX `identify_rate_limit_buckets_appId_routeKey_windowStart_key`(`appId`, `routeKey`, `windowStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_password_resets` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `user_password_resets_tokenHash_key`(`tokenHash`),
    INDEX `user_password_resets_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_invites` ADD CONSTRAINT `user_invites_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_invites` ADD CONSTRAINT `user_invites_invitedById_fkey` FOREIGN KEY (`invitedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `apps` ADD CONSTRAINT `apps_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `apps` ADD CONSTRAINT `apps_partnerConnectionId_fkey` FOREIGN KEY (`partnerConnectionId`) REFERENCES `shopify_partner_connections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_reviews` ADD CONSTRAINT `app_reviews_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `traffic_saved_filters` ADD CONSTRAINT `traffic_saved_filters_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `saved_report_views` ADD CONSTRAINT `saved_report_views_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `traffic_event_facts` ADD CONSTRAINT `traffic_event_facts_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_subscription_events` ADD CONSTRAINT `partner_subscription_events_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_subscription_sale_facts` ADD CONSTRAINT `partner_subscription_sale_facts_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_subscription_states` ADD CONSTRAINT `partner_subscription_states_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_customer_states` ADD CONSTRAINT `partner_customer_states_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_comments` ADD CONSTRAINT `customer_comments_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_comments` ADD CONSTRAINT `customer_comments_authorUserId_fkey` FOREIGN KEY (`authorUserId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_daily_mrr_snapshots` ADD CONSTRAINT `partner_daily_mrr_snapshots_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_daily_plan_mrr_snapshots` ADD CONSTRAINT `partner_daily_plan_mrr_snapshots_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_offer_cadence_inferences` ADD CONSTRAINT `partner_offer_cadence_inferences_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_charge_live_discount_checks` ADD CONSTRAINT `partner_charge_live_discount_checks_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_daily_logo_churn_snapshots` ADD CONSTRAINT `partner_daily_logo_churn_snapshots_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `partner_daily_install_snapshots` ADD CONSTRAINT `partner_daily_install_snapshots_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shopify_partner_connections` ADD CONSTRAINT `shopify_partner_connections_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_installs` ADD CONSTRAINT `app_installs_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_partner_events` ADD CONSTRAINT `raw_partner_events_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_lifecycle_events` ADD CONSTRAINT `account_lifecycle_events_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_lifecycle_events` ADD CONSTRAINT `account_lifecycle_events_appInstallId_fkey` FOREIGN KEY (`appInstallId`) REFERENCES `app_installs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_lifecycle_events` ADD CONSTRAINT `account_lifecycle_events_rawPartnerEventId_fkey` FOREIGN KEY (`rawPartnerEventId`) REFERENCES `raw_partner_events`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `uninstall_event_details` ADD CONSTRAINT `uninstall_event_details_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `account_lifecycle_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plans` ADD CONSTRAINT `plans_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plans` ADD CONSTRAINT `plans_autoUpgradeToPlanId_fkey` FOREIGN KEY (`autoUpgradeToPlanId`) REFERENCES `plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_features` ADD CONSTRAINT `plan_features_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_feature_entitlements` ADD CONSTRAINT `plan_feature_entitlements_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_feature_entitlements` ADD CONSTRAINT `plan_feature_entitlements_featureId_fkey` FOREIGN KEY (`featureId`) REFERENCES `plan_features`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_appInstallId_fkey` FOREIGN KEY (`appInstallId`) REFERENCES `app_installs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_replacesSubscriptionId_fkey` FOREIGN KEY (`replacesSubscriptionId`) REFERENCES `subscriptions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscription_line_items` ADD CONSTRAINT `subscription_line_items_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `subscriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `charges` ADD CONSTRAINT `charges_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `subscriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_one_time_purchases` ADD CONSTRAINT `app_one_time_purchases_appInstallId_fkey` FOREIGN KEY (`appInstallId`) REFERENCES `app_installs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_one_time_purchases` ADD CONSTRAINT `app_one_time_purchases_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `discounts` ADD CONSTRAINT `discounts_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `discounts` ADD CONSTRAINT `discounts_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `discount_apps` ADD CONSTRAINT `discount_apps_discountId_fkey` FOREIGN KEY (`discountId`) REFERENCES `discounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `discount_apps` ADD CONSTRAINT `discount_apps_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `discount_redemptions` ADD CONSTRAINT `discount_redemptions_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `discount_redemptions` ADD CONSTRAINT `discount_redemptions_discountId_fkey` FOREIGN KEY (`discountId`) REFERENCES `discounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_rate_limit_buckets` ADD CONSTRAINT `api_rate_limit_buckets_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_request_logs` ADD CONSTRAINT `api_request_logs_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `api_request_logs` ADD CONSTRAINT `api_request_logs_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscription_discounts` ADD CONSTRAINT `subscription_discounts_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `subscriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscription_discounts` ADD CONSTRAINT `subscription_discounts_discountId_fkey` FOREIGN KEY (`discountId`) REFERENCES `discounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `usage_events` ADD CONSTRAINT `usage_events_appInstallId_fkey` FOREIGN KEY (`appInstallId`) REFERENCES `app_installs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flex_billing_events` ADD CONSTRAINT `flex_billing_events_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flex_billing_events` ADD CONSTRAINT `flex_billing_events_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `subscriptions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `flex_billing_events` ADD CONSTRAINT `flex_billing_events_previousSubscriptionId_fkey` FOREIGN KEY (`previousSubscriptionId`) REFERENCES `subscriptions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `identify_api_keys` ADD CONSTRAINT `identify_api_keys_appId_fkey` FOREIGN KEY (`appId`) REFERENCES `apps`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `identify_api_keys` ADD CONSTRAINT `identify_api_keys_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_password_resets` ADD CONSTRAINT `user_password_resets_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

