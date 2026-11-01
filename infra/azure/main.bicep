// SAAS_RSA on Azure, South Africa North (Johannesburg).
//
//   az deployment group create -g <resource-group> -f infra/azure/main.bicep -p infra/azure/main.parameters.json
//
// Creates: Log Analytics, PostgreSQL 16 Flexible Server, a Container Apps
// environment, the API (public HTTPS), the notification worker, and a manual
// "migrate" job that applies migrations and seeds rules. See docs/DEPLOY_AZURE.md.

targetScope = 'resourceGroup'

@description('Azure region. South Africa North keeps employee data in-country.')
param location string = 'southafricanorth'

@description('Short lowercase prefix for resource names.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'saasrsa'

// --- Images (published by CI to GitHub Container Registry) ---
@description('API image, e.g. ghcr.io/c4lv1n05/saas_rsa-api:main')
param apiImage string
@description('Worker image, e.g. ghcr.io/c4lv1n05/saas_rsa-worker:main')
param workerImage string
@description('GitHub username for pulling private GHCR images. Leave empty for public packages.')
param ghcrUsername string = ''
@secure()
@description('GitHub token with read:packages. Leave empty for public packages.')
param ghcrToken string = ''

// --- Database ---
param postgresAdminLogin string = 'saas_owner'
@secure()
param postgresAdminPassword string
@secure()
@description('Password for the saas_app role the API connects as (subject to RLS).')
param appDbPassword string
@secure()
@description('Password for the saas_worker role (outbox functions only).')
param workerDbPassword string
@description('Burstable B1ms is enough for pilots; move to General Purpose for production load.')
param postgresSkuName string = 'Standard_B1ms'
param postgresSkuTier string = 'Burstable'
@description('Geo-redundant backups replicate to the paired region, South Africa West, so data stays in South Africa.')
@allowed(['Enabled', 'Disabled'])
param postgresGeoRedundantBackup string = 'Disabled'

// --- Auth0 ---
@description('Auth0 tenant domain, e.g. saas-rsa.eu.auth0.com')
param auth0Domain string
@description('Auth0 API identifier (the access token audience).')
param auth0Audience string = 'https://api.saas-rsa.app'
@secure()
@description('Shared secret between the Auth0 Post-Login Action and the API (32+ characters).')
param authActionSecret string

@description('Guest ordering app URL (your custom domain). Empty = the Static Web App address.')
param guestAppUrl string = ''

@description('Static Web Apps host the static web app globally; this is only where its metadata lives (it stores no personal data).')
@allowed(['westeurope', 'eastus2', 'centralus', 'westus2', 'eastasia'])
param webLocation string = 'westeurope'

// --- Twilio (all optional: without them the worker logs messages instead of sending) ---
param twilioAccountSid string = ''
@secure()
param twilioAuthToken string = ''
@description('South African SMS sender number in E.164, e.g. +27...')
param twilioSmsFrom string = ''
param twilioMessagingServiceSid string = ''
@description('WhatsApp sender in E.164, e.g. +27...')
param twilioWhatsappFrom string = ''
@description('JSON map of template name to approved Twilio Content SID, e.g. {"schedule_published":"HX..."}')
param twilioWhatsappContentSids string = '{}'

var suffix = uniqueString(resourceGroup().id)
var pgServerName = toLower('${namePrefix}-pg-${suffix}')
var dbName = 'saas_rsa'
var useGhcrAuth = !empty(ghcrToken)

// Guest ordering app and staff screens (static files; all data comes from the API).
resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${namePrefix}-web'
  location: webLocation
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

var webOrigin = 'https://${web.properties.defaultHostname}'
var effectiveGuestAppUrl = empty(guestAppUrl) ? webOrigin : guestAppUrl

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgServerName
  location: location
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 14
      geoRedundantBackup: postgresGeoRedundantBackup
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: dbName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Container Apps on the consumption plan have no fixed outbound IP, so allow
// Azure services. For production, move to a VNet-integrated environment with
// private access (see docs/DEPLOY_AZURE.md, "Hardening").
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

var pgHost = postgres.properties.fullyQualifiedDomainName
var ownerUrl = 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pgHost}:5432/${dbName}?sslmode=require'
var appUrl = 'postgres://saas_app:${uriComponent(appDbPassword)}@${pgHost}:5432/${dbName}?sslmode=require'
var workerUrl = 'postgres://saas_worker:${uriComponent(workerDbPassword)}@${pgHost}:5432/${dbName}?sslmode=require'

// Menu photos: public, read-only blobs in South Africa North. The API re-encodes
// every upload (location data stripped) before it lands here.
var mediaContainerName = 'menu-images'
resource media 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take(toLower(replace('${namePrefix}media${suffix}', '-', '')), 24)
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: true
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource mediaBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: media
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        { allowedOrigins: ['*'], allowedMethods: ['GET', 'HEAD'], allowedHeaders: ['*'], exposedHeaders: [], maxAgeInSeconds: 86400 }
      ]
    }
  }
}

resource mediaContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: mediaBlobs
  name: mediaContainerName
  properties: { publicAccess: 'Blob' }
}

var mediaConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${media.name};AccountKey=${media.listKeys().keys[0].value};EndpointSuffix=${az.environment().suffixes.storage}'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var registrySecrets = useGhcrAuth ? [{ name: 'ghcr-token', value: ghcrToken }] : []
var registries = useGhcrAuth ? [{ server: 'ghcr.io', username: ghcrUsername, passwordSecretRef: 'ghcr-token' }] : []

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-api'
  location: location
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: concat(registrySecrets, [
        { name: 'database-url', value: appUrl }
        { name: 'auth-action-secret', value: authActionSecret }
        { name: 'media-connection-string', value: mediaConnectionString }
      ])
      registries: registries
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'LOG_LEVEL', value: 'info' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'AUTH_JWKS_URL', value: 'https://${auth0Domain}/.well-known/jwks.json' }
            { name: 'AUTH_ISSUER', value: 'https://${auth0Domain}/' }
            { name: 'AUTH_AUDIENCE', value: auth0Audience }
            { name: 'AUTH_ACTION_SECRET', secretRef: 'auth-action-secret' }
            { name: 'GUEST_APP_URL', value: effectiveGuestAppUrl }
            { name: 'CORS_ORIGINS', value: webOrigin }
            { name: 'MEDIA_STORE', value: 'azure' }
            { name: 'MEDIA_CONTAINER', value: mediaContainer.name }
            { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'media-connection-string' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/health', port: 3000 }, periodSeconds: 10 }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-worker'
  location: location
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      secrets: concat(registrySecrets, [
        { name: 'database-url', value: workerUrl }
        { name: 'twilio-auth-token', value: empty(twilioAuthToken) ? 'unset' : twilioAuthToken }
      ])
      registries: registries
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: workerImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(
            [
              { name: 'NODE_ENV', value: 'production' }
              { name: 'DATABASE_URL', secretRef: 'database-url' }
              { name: 'TWILIO_ACCOUNT_SID', value: twilioAccountSid }
              { name: 'TWILIO_SMS_FROM', value: twilioSmsFrom }
              { name: 'TWILIO_MESSAGING_SERVICE_SID', value: twilioMessagingServiceSid }
              { name: 'TWILIO_WHATSAPP_FROM', value: twilioWhatsappFrom }
              { name: 'TWILIO_WHATSAPP_CONTENT_SIDS', value: twilioWhatsappContentSids }
            ],
            empty(twilioAuthToken) ? [] : [{ name: 'TWILIO_AUTH_TOKEN', secretRef: 'twilio-auth-token' }]
          )
        }
      ]
      // One replica is plenty; the outbox's SKIP LOCKED claims make more replicas safe too.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// Run before each release: applies new migrations, then re-seeds national rules.
resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: '${namePrefix}-migrate'
  location: location
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: concat(registrySecrets, [
        { name: 'owner-url', value: ownerUrl }
        { name: 'app-db-password', value: appDbPassword }
        { name: 'worker-db-password', value: workerDbPassword }
      ])
      registries: registries
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: apiImage
          command: ['sh', '-c', 'node dist/migrate.js && node dist/seed.js']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DATABASE_OWNER_URL', secretRef: 'owner-url' }
            { name: 'APP_DB_PASSWORD', secretRef: 'app-db-password' }
            { name: 'WORKER_DB_PASSWORD', secretRef: 'worker-db-password' }
            { name: 'MIGRATIONS_DIR', value: '/app/migrations' }
          ]
        }
      ]
    }
  }
  dependsOn: [database, allowAzure]
}

output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output webUrl string = effectiveGuestAppUrl
output postgresHost string = pgHost
output migrateJobName string = migrate.name
output mediaBaseUrl string = '${media.properties.primaryEndpoints.blob}${mediaContainerName}'
