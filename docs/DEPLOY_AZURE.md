# Deploying to Azure, Auth0 and Twilio

The platform runs in **Azure South Africa North** (Johannesburg): PostgreSQL 16 Flexible Server, an Azure Container Apps environment with the API and the notification worker, and a migration job. Auth0 handles sign-in. Twilio sends WhatsApp and SMS messages.

After the one-time setup below, every push to `main` that passes CI is deployed automatically: images are built, the migration job runs, then the API and worker roll out and a health check confirms the release.

```
Auth0 (login) ──token──> API (Container App, HTTPS) ──> PostgreSQL 16 (South Africa North)
       └─ Post-Login Action ──> /internal/auth/claims        ^
                                                            │ outbox
Twilio (WhatsApp, SMS) <── worker (Container App) ──────────┘
```

Redis is not used: new Azure Cache for Redis instances have been blocked for new customers since 1 April 2026, so notifications use a PostgreSQL outbox instead.

## 1. Azure: resource group and first deployment

Requires the Azure CLI (`az login`).

```bash
az group create -n saas-rsa-prod -l southafricanorth

# Strong passwords: keep them in a password manager.
PG_ADMIN=$(openssl rand -base64 24); APP_DB=$(openssl rand -base64 24)
WORKER_DB=$(openssl rand -base64 24); ACTION=$(openssl rand -hex 32)

az deployment group create -g saas-rsa-prod \
  -f infra/azure/main.bicep -p infra/azure/main.parameters.json \
  -p postgresAdminPassword="$PG_ADMIN" appDbPassword="$APP_DB" \
     workerDbPassword="$WORKER_DB" authActionSecret="$ACTION" \
     auth0Domain=<your-tenant>.eu.auth0.com

# First migration (CI does this on every later release):
az containerapp job start -g saas-rsa-prod -n saasrsa-migrate
```

The output `apiUrl` is the API's public address, and `webUrl` is the guest ordering app and staff screens (Azure Static Web Apps). Table QR codes point at `webUrl`. Menu photos go to the `menu-images` Blob container in a storage account the template creates in South Africa North (`mediaBaseUrl`); the API gets its connection string as a Container Apps secret. To use your own domain (e.g. `order.yourrestaurant.co.za`), add it to the Static Web App in the portal, then redeploy with `guestAppUrl=https://order.yourrestaurant.co.za`. Keep `ACTION` for step 3.

**Container images.** The repository is public, but GitHub can still create the container packages as private. Either make the `saas_rsa-api` and `saas_rsa-worker` packages public (GitHub profile → Packages → package settings → Change visibility), or pass `ghcrUsername` and a `ghcrToken` with `read:packages` to the deployment.

## 2. GitHub: let CI deploy (OIDC, no stored Azure secrets)

```bash
SUB=$(az account show --query id -o tsv); TENANT=$(az account show --query tenantId -o tsv)
APP_ID=$(az ad app create --display-name saas-rsa-github --query appId -o tsv)
az ad sp create --id "$APP_ID"
az role assignment create --assignee "$APP_ID" --role Contributor \
  --scope "/subscriptions/$SUB/resourceGroups/saas-rsa-prod"
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-production",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:C4LV1N05/SAAS_RSA:environment:production",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

Then in GitHub → Settings → Secrets and variables → Actions → **Variables**, add:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | `$APP_ID` |
| `AZURE_TENANT_ID` | `$TENANT` |
| `AZURE_SUBSCRIPTION_ID` | `$SUB` |
| `AZURE_RESOURCE_GROUP` | `saas-rsa-prod` |

For the staff screens' sign-in, also add `AUTH0_DOMAIN`, `AUTH0_SPA_CLIENT_ID` and `AUTH0_AUDIENCE` (step 3).

The deploy job stays off until `AZURE_CLIENT_ID` is set. It runs in the GitHub `production` environment; you can add a required reviewer there to approve each release.

## 3. Auth0

1. **Create the API:** Applications → APIs → Create API. Identifier: `https://api.saas-rsa.app` (must match `auth0Audience`). Signing algorithm: RS256.
2. **Staff sign-in by SMS:** Authentication → Passwordless → SMS. Choose Twilio as the provider and enter your Twilio Account SID, Auth Token and sender number, so one Twilio account serves both sign-in codes and staff messages.
3. **Managers and owners:** keep Username-Password with MFA on (Security → Multi-factor Auth).
4. **Claims Action:** Actions → Library → Create Action → *Login / Post Login*. Paste `infra/auth0/post-login-action.js`. Add secrets `API_BASE_URL` (the `apiUrl` output) and `AUTH_ACTION_SECRET` (the `ACTION` value from step 1). Deploy it, then add it to Actions → Triggers → post-login.
5. **Staff screens app:** create a Single Page Application. Set Allowed Callback URLs, Allowed Logout URLs and Allowed Web Origins to `<webUrl>/staff` (and `http://localhost:5173/staff` for development). Put its Client ID in the GitHub variable `AUTH0_SPA_CLIENT_ID`, and turn on refresh token rotation.

**How staff get access:** a manager adds an employee with their mobile number. The employee signs in with an SMS code. On that first login, the Action calls the API, which links the Auth0 account to the invited record by verified phone number. Someone with no invitation is refused.

## 4. Twilio

1. **SMS:** buy or port a South African number, or create a Messaging Service, and set `twilioSmsFrom` or `twilioMessagingServiceSid`.
2. **WhatsApp:** register a WhatsApp sender (Messaging → Senders → WhatsApp senders). Meta approval takes days, so start early.
3. **Templates:** create Content templates (Messaging → Content Template Builder) and submit them for WhatsApp approval. Use these placeholders:

   | Template | Text pattern |
   | --- | --- |
   | `schedule_published` | Hi {{1}}, your schedule has been published: {{2}} shift(s). |
   | `shift_changed` | Hi {{1}}, a shift on {{2}} has changed. |
   | `payslip_ready` | Hi {{1}}, your payslip for {{2}} is ready. |
   | `logbook_ack_required` | New log book note at {{1}} needs your acknowledgement. |

4. Pass the approved Content SIDs as `twilioWhatsappContentSids`, e.g. `{"schedule_published":"HX..."}`, plus `twilioAccountSid` and `twilioAuthToken`, and redeploy step 1's command.

Until a template is approved, its messages go by SMS automatically. Without Twilio settings, the worker logs messages instead of sending them.

**Delivery tracking:** every message is a row in `notification_outbox` with its status (`queued`, `sending`, `sent`, `failed`), the channel used, the Twilio message SID and the last error. Failures retry with exponential backoff, up to 6 attempts.

## Hardening before real customers

- **Private networking:** move the Container Apps environment into a VNet and give PostgreSQL private access, then remove the `AllowAzureServices` firewall rule.
- **Backups:** set `postgresGeoRedundantBackup=Enabled`; the paired region is South Africa West, so backups stay in South Africa.
- **Secrets:** move secrets to Azure Key Vault references.
- **Scale:** move PostgreSQL to General Purpose with zone-redundant high availability once there are paying customers.
- **Alerts:** add alerts on API 5xx rates, failed migration job runs, and outbox rows in `failed`.
