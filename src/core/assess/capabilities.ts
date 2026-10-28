// Capability model and codebase summary for the assessment (M8: FR-PROJ-002/003/004, DEC-023).
//
// Every status comes from patterns over what the snapshot read: declared
// dependencies, file paths, code, configuration names and documentation.
// A name in code or docs is never taken as proof that an outside service is
// connected; anything that lives outside the repository is "not verified"
// until a connector can check it with an authorised request (FR-PROJ-005).

import type { Snapshot } from './snapshot.ts';
import { redactString } from '../redact.ts';

export type CategoryId = 'product' | 'operations' | 'interfaces' | 'management';
export type Level = 'high' | 'medium' | 'low';
/**
 * `configured_externally` needs authorised evidence from a connector. No
 * connector exists yet, so the assessment never assigns it.
 */
export type CapabilityStatus = 'implemented_in_code' | 'configured_externally' | 'partly_present' | 'missing' | 'not_verified' | 'not_applicable';

export const CATEGORIES: { id: CategoryId; title: string }[] = [
  { id: 'product', title: 'Product' },
  { id: 'operations', title: 'Operations' },
  { id: 'interfaces', title: 'Interfaces' },
  { id: 'management', title: 'Management' },
];

export interface Capability {
  id: string;
  title: string;
  category: CategoryId;
  impact: Level;
  /** Its real state lives with an outside provider, so the repository can only show part of it. */
  external?: boolean;
  /** Usually set up entirely outside the code; finding nothing is "not verified", not "missing". */
  externalOnly?: boolean;
  /** How many kinds of code evidence make it "implemented" (default 2). */
  strongWith?: number;
  deps?: string[];
  files?: RegExp[];
  code?: RegExp[];
  env?: RegExp;
  /** Words that, in documentation only, show the capability is talked about. */
  mentions?: RegExp;
  advice: string;
}

export interface CapabilityFinding {
  id: string;
  title: string;
  category: CategoryId;
  status: CapabilityStatus;
  confidence: Level;
  impact: Level;
  evidence: string[];
  /** How the evidence led to the status. */
  reasoning: string;
  /** Set when part of the capability lives outside the repository and could not be checked. */
  externalState: 'not_verified' | null;
  nextAction: string;
}

export interface Observation {
  title: string;
  evidence: string[];
  confidence: Level;
  impact: Level;
  nextAction: string;
}

const CONFIG_FILE = /\.(ya?ml|json|toml|ini|cfg|conf|env\.example|env\.sample|env\.template)$|(^|\/)(Dockerfile|Procfile|Makefile|Jenkinsfile)$/;

export const CAPABILITIES: Capability[] = [
  // Product
  { id: 'overview', title: 'Overview', category: 'product', impact: 'medium', strongWith: 1, files: [/^README(\.[a-z]+)?$/i, /(^|\/)docs\/(overview|introduction|about)[^/]*\.(md|mdx|txt)$/i], advice: 'Add a README that says what the project does, for whom, and how to run it.' },
  { id: 'pitch_deck', title: 'Pitch Deck', category: 'product', impact: 'low', strongWith: 1, files: [/(^|\/)[^/]*(pitch|deck)[^/]*\.(pptx?|key|pdf|md|mdx)$/i], advice: 'Add a pitch deck only if the project needs one for funding or sign-off.' },
  { id: 'assessment', title: 'Assessment', category: 'product', impact: 'low', strongWith: 1, files: [/(^|\/)[^/]*(assessment|audit|review)[^/]*\.(md|mdx|pdf)$/i], advice: 'Keep this report: the app saves it in the project folder, not in the repository.' },
  { id: 'roadmap', title: 'Roadmap', category: 'product', impact: 'medium', strongWith: 1, files: [/(^|\/)[^/]*roadmap[^/]*\.(md|mdx|txt|pdf)$/i], mentions: /^#+\s*roadmap\b/im, advice: 'Write down what comes next and in what order, for example a ROADMAP.md.' },

  // Operations
  {
    id: 'analytics', title: 'Analytics', category: 'operations', impact: 'medium', external: true,
    deps: ['posthog-js', 'posthog-node', 'posthog', '@vercel/analytics', 'mixpanel', 'mixpanel-browser', '@segment/analytics-next', '@segment/analytics-node', 'analytics-node', 'react-ga4', '@amplitude/*', 'plausible-tracker', '@google-analytics/*', 'universal-analytics'],
    code: [/gtag\(|googletagmanager\.com|plausible\.io\/js|posthog\.(init|capture)\(|mixpanel\.(init|track)\(|analytics\.(track|page)\(/],
    env: /POSTHOG|MIXPANEL|SEGMENT|PLAUSIBLE|AMPLITUDE|^GA_|_GA_|MEASUREMENT_ID|GTM_ID/,
    mentions: /\b(posthog|mixpanel|plausible|google analytics|amplitude|product analytics)\b/i,
    advice: 'Decide which product events matter and add an analytics library that respects consent.',
  },
  {
    id: 'performance', title: 'Performance', category: 'operations', impact: 'medium', external: true,
    deps: ['@vercel/speed-insights', 'web-vitals', 'lighthouse', '@lhci/cli', 'k6', 'autocannon', 'newrelic', 'dd-trace', '@opentelemetry/*', 'opentelemetry-*', 'locust', 'pytest-benchmark', 'tinybench', 'benchmark'],
    files: [/(^|\/)(k6|load-?tests?|loadtest|bench(marks?)?|perf)\//i, /\.bench\.[cm]?[jt]sx?$/, /(^|\/)lighthouserc\.[a-z]+$/],
    code: [/tracesSampleRate|reportWebVitals|onCLS\(|onLCP\(|performance\.mark\(|new PerformanceObserver/],
    advice: 'Measure the slow paths (page load, key API calls) and set a target for them.',
  },
  {
    id: 'usage_cost', title: 'Usage & Cost', category: 'operations', impact: 'medium',
    code: [/\b(usage|cost|spend|billing)[_ ]?(ledger|meter(ing)?|tracking|report|limit|cap)\b|\b(input|output)_tokens\b|cost_?usd|monthly_?budget|usage_?quota/i],
    env: /BUDGET|QUOTA|SPEND_LIMIT|USAGE_LIMIT/,
    deps: ['openmeter', '@openmeter/*', 'lago-javascript-client', 'tiktoken', '@anthropic-ai/tokenizer'],
    advice: 'Track what each user or feature costs to run, and set limits before costs grow.',
  },
  {
    id: 'issues', title: 'Issues', category: 'operations', impact: 'high', external: true,
    deps: ['@sentry/*', 'sentry-sdk', 'raven', 'bugsnag', '@bugsnag/*', 'rollbar', '@honeybadger-io/*', 'honeybadger', '@datadog/browser-logs', 'logrocket'],
    files: [/^\.github\/ISSUE_TEMPLATE\//, /^\.github\/issue_template\.md$/i],
    code: [/Sentry\.init\(|sentry_sdk\.init\(|Bugsnag\.start\(|new Rollbar\(|Honeybadger\.configure\(/],
    env: /SENTRY|BUGSNAG|ROLLBAR|HONEYBADGER/,
    mentions: /\b(sentry|bugsnag|rollbar|honeybadger|error (tracking|reporting|monitoring))\b/i,
    advice: 'Add error reporting so failures in production reach you, and an issue template for bug reports.',
  },
  {
    id: 'database', title: 'Database', category: 'operations', impact: 'high', external: true,
    deps: ['pg', 'postgres', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'sequelize', 'knex', 'kysely', 'better-sqlite3', 'sqlite3', '@neondatabase/serverless', '@supabase/supabase-js', '@planetscale/database', '@libsql/client', 'sqlalchemy', 'psycopg2', 'psycopg2-binary', 'psycopg', 'pymongo', 'asyncpg', 'django', 'peewee', 'tortoise-orm', 'activerecord', 'pg-promise', 'gorm.io/gorm', 'github.com/jackc/pgx/*', 'diesel', 'sqlx', 'Microsoft.EntityFrameworkCore*', 'Npgsql*'],
    files: [/(^|\/)schema\.prisma$/, /(^|\/)(migrations?|alembic|db\/migrate)\//i, /\.sql$/i, /(^|\/)drizzle\.config\.[cm]?[jt]s$/, /(^|\/)knexfile\.[cm]?[jt]s$/],
    code: [/CREATE TABLE|new Pool\(|createPool\(|mongoose\.connect\(|new PrismaClient\(|drizzle\(|create_engine\(|models\.Model\b|DatabaseSync\(/],
    env: /DATABASE_URL|POSTGRES|PGHOST|MYSQL|MONGO|DB_HOST|DB_URL|SUPABASE|NEON/,
    mentions: /\b(postgres(ql)?|mysql|mongodb|supabase|neon|planetscale|sqlite)\b/i,
    advice: 'Choose where data lives and add a schema with migrations, so changes are repeatable.',
  },
  {
    id: 'vector_db', title: 'Vector Database', category: 'operations', impact: 'low', external: true,
    deps: ['@pinecone-database/pinecone', 'pinecone-client', 'pinecone', 'chromadb', 'weaviate-client', 'weaviate-ts-client', '@qdrant/js-client-rest', 'qdrant-client', 'pgvector', 'faiss-cpu', 'faiss-gpu', '@lancedb/lancedb', 'lancedb', 'pymilvus', '@zilliz/milvus2-sdk-node', '@upstash/vector'],
    code: [/CREATE EXTENSION (IF NOT EXISTS )?vector|\bvector\(\d+\)|<=>\s*\$\d|similarity_search\(|\.upsert\(\{\s*vectors/i],
    env: /PINECONE|QDRANT|WEAVIATE|CHROMA|MILVUS|UPSTASH_VECTOR/,
    advice: 'Only needed for semantic search or retrieval; mark it not applicable otherwise.',
  },
  {
    id: 'deployments', title: 'Deployments', category: 'operations', impact: 'high', external: true, strongWith: 1,
    files: [/(^|\/)Dockerfile$/, /(^|\/)docker-compose[^/]*\.ya?ml$/, /(^|\/)compose\.ya?ml$/, /^vercel\.json$/, /^netlify\.toml$/, /^fly\.toml$/, /^render\.ya?ml$/, /^app\.ya?ml$/, /^Procfile$/, /^serverless\.ya?ml$/, /\.tf$/, /(^|\/)(k8s|kubernetes|helm|charts)\//, /^\.github\/workflows\/[^/]*deploy[^/]*\.ya?ml$/i, /^azure-pipelines\.ya?ml$/, /^amplify\.ya?ml$/, /^railway\.(json|toml)$/, /^wrangler\.toml$/],
    code: [/^\s*(-\s*)?(name|uses|run):.*\b(deploy|vercel|netlify|flyctl|wrangler|azure\/webapps-deploy|aws-actions)\b/im],
    env: /VERCEL|NETLIFY|FLY_|RENDER_|HEROKU|AZURE_WEBAPP|DEPLOY/,
    mentions: /\b(vercel|netlify|fly\.io|heroku|render\.com|azure app service|cloud run|deployed (to|on))\b/i,
    advice: 'Describe how and where the app is deployed as configuration in the repository.',
  },
  {
    id: 'file_storage', title: 'File Storage', category: 'operations', impact: 'medium', external: true,
    deps: ['@aws-sdk/client-s3', 'aws-sdk', '@google-cloud/storage', '@azure/storage-blob', '@vercel/blob', 'uploadthing', 'cloudinary', 'multer', 'formidable', 'boto3', 'minio', 'django-storages', '@supabase/storage-js', 'Azure.Storage.Blobs'],
    code: [/new S3Client\(|PutObjectCommand|putObject\(|upload_file\(|BlobServiceClient|getSignedUrl\(|\.storage\.from\(|put\(\s*['"`][^'"`]+['"`]\s*,.*access:/],
    env: /S3_|BUCKET|BLOB_|CLOUDINARY|STORAGE_ACCOUNT|UPLOADTHING/,
    advice: 'Decide where uploaded files are kept and who may read them.',
  },
  {
    id: 'domains', title: 'Domains', category: 'operations', impact: 'medium', external: true, externalOnly: true, strongWith: 1,
    files: [/^CNAME$/],
    code: [/"domains"\s*:|"alias"\s*:\s*\[/],
    env: /DOMAIN|HOSTNAME|BASE_URL|SITE_URL|PUBLIC_URL|APP_URL|NEXTAUTH_URL/,
    advice: 'Record which domains the app uses and who controls their DNS.',
  },
  {
    id: 'secrets', title: 'Secrets', category: 'operations', impact: 'high', external: true,
    deps: ['dotenv', '@dotenvx/dotenvx', 'env-cmd', '@t3-oss/env-nextjs', '@t3-oss/env-core', 'envalid', 'python-dotenv', 'pydantic-settings', '@aws-sdk/client-secrets-manager', '@azure/keyvault-secrets', '@google-cloud/secret-manager', 'hvac', 'node-vault', 'keytar'],
    files: [/(^|\/)\.env\.(example|sample|template|dist)$/],
    code: [/process\.env\b|import\.meta\.env\b|os\.environ|os\.getenv\(|Environment\.GetEnvironmentVariable|ENV\[|System\.getenv\(|safeStorage|keytar\./],
    advice: 'Read secrets from the environment or a secrets store, list their names in an example file, and keep values out of the repository.',
  },
  {
    id: 'code', title: 'Code', category: 'operations', impact: 'medium',
    files: [/(^|\/)(\.eslintrc(\.[a-z]+)?|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?[jt]s|ruff\.toml|\.flake8|\.pylintrc|\.rubocop\.yml|\.golangci\.ya?ml|rustfmt\.toml|\.editorconfig|tsconfig\.json|mypy\.ini|\.pre-commit-config\.yaml)$/, /^\.github\/workflows\/[^/]+\.ya?ml$/, /^\.gitlab-ci\.yml$/, /^CODEOWNERS$|^\.github\/CODEOWNERS$/, /^\.github\/pull_request_template\.md$/i],
    deps: ['eslint', 'prettier', '@biomejs/biome', 'typescript', 'ruff', 'black', 'flake8', 'pylint', 'mypy', 'rubocop', 'husky', 'lint-staged'],
    advice: 'Add a linter or type check and run it on every change.',
  },
  {
    id: 'automation', title: 'Automation', category: 'operations', impact: 'medium', external: true, strongWith: 1,
    files: [/^\.github\/workflows\/[^/]+\.ya?ml$/, /^\.gitlab-ci\.yml$/, /^Jenkinsfile$/, /^azure-pipelines\.ya?ml$/, /^\.circleci\/config\.yml$/, /^bitbucket-pipelines\.yml$/, /^\.github\/dependabot\.yml$/, /^renovate\.json5?$|^\.renovaterc(\.json)?$/, /^\.husky\//],
    advice: 'Run the tests and checks automatically on every change, for example with GitHub Actions.',
  },
  {
    id: 'custom_models', title: 'Custom Models', category: 'operations', impact: 'medium', external: true,
    deps: ['@anthropic-ai/sdk', 'anthropic', 'openai', '@google/generative-ai', '@google/genai', 'google-generativeai', 'langchain', '@langchain/*', 'langchain-*', 'ai', '@ai-sdk/*', 'transformers', '@huggingface/inference', '@huggingface/transformers', 'torch', 'tensorflow', '@tensorflow/tfjs', 'ollama', 'cohere-ai', 'cohere', '@mistralai/mistralai', 'mistralai', 'llama-index', 'llamaindex', 'replicate', 'Anthropic.SDK', 'Azure.AI.OpenAI'],
    files: [/\.(onnx|safetensors|gguf|pt|pth|h5)$/i, /(^|\/)(fine[-_]?tun[a-z]*|training)\//i],
    code: [/messages\.create\(|chat\.completions\.create\(|generateContent\(|generateText\(|streamText\(|AutoModel(ForCausalLM)?\.from_pretrained\(|new (Anthropic|OpenAI)\(/],
    env: /ANTHROPIC|OPENAI|HF_TOKEN|HUGGINGFACE|GEMINI|GOOGLE_API_KEY|MISTRAL|COHERE|REPLICATE/,
    advice: 'Only needed if the product uses AI models; mark it not applicable otherwise.',
  },

  // Interfaces
  {
    id: 'api', title: 'API', category: 'interfaces', impact: 'high',
    deps: ['express', 'fastify', 'koa', 'hono', '@hapi/hapi', '@nestjs/core', 'next', '@trpc/server', 'graphql', '@apollo/server', 'apollo-server', 'graphql-yoga', 'flask', 'fastapi', 'django', 'djangorestframework', 'starlette', 'rails', 'sinatra', 'laravel/framework', 'slim/slim', 'github.com/gin-gonic/gin', 'github.com/labstack/echo/*', 'github.com/gofiber/fiber/*', 'actix-web', 'axum', 'rocket', 'spring-boot-starter-web', 'Swashbuckle.AspNetCore'],
    files: [/(^|\/)(pages|app|src\/app|src\/pages)\/api\//, /(^|\/)routes?\//, /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i, /(^|\/)controllers?\//],
    code: [/\b(app|router|server|fastify)\.(get|post|put|patch|delete|route)\(\s*['"`]\//, /@(app|router|api_view|bp)\.(get|post|put|patch|delete|route)\(/, /export (async )?function (GET|POST|PUT|PATCH|DELETE)\b/, /@(Get|Post|Put|Patch|Delete)Mapping\b|\[Http(Get|Post|Put|Delete)\]|@(Get|Post|Put|Delete)\(\s*['"`]?/],
    advice: 'If other systems or a front end need data, define the API and document it, for example with OpenAPI.',
  },
  {
    id: 'mcp', title: 'MCP', category: 'interfaces', impact: 'low',
    deps: ['@modelcontextprotocol/sdk', 'mcp', 'fastmcp', '@modelcontextprotocol/*'],
    files: [/(^|\/)\.?mcp\.json$/],
    code: [/new McpServer\(|McpServer\(|FastMCP\(|@mcp\.tool|server\.tool\(\s*['"`]/],
    advice: 'Only needed if AI assistants should use this system as a tool; mark it not applicable otherwise.',
  },
  {
    id: 'voice', title: 'Voice', category: 'interfaces', impact: 'low', external: true,
    deps: ['@deepgram/sdk', 'deepgram-sdk', 'assemblyai', 'elevenlabs', '@elevenlabs/elevenlabs-js', 'livekit-client', '@livekit/*', 'livekit', '@vapi-ai/web', '@vapi-ai/server-sdk', 'twilio', 'openai-whisper', 'speechrecognition', 'pyttsx3', '@google-cloud/speech', '@google-cloud/text-to-speech', 'microsoft-cognitiveservices-speech-sdk'],
    code: [/SpeechRecognition|speechSynthesis\.|audio\.transcriptions|text[-_]to[-_]speech|\btts\(|\.calls\.create\(|<Say>|VoiceResponse\(/i],
    env: /DEEPGRAM|ASSEMBLYAI|ELEVENLABS|LIVEKIT|VAPI|TWILIO/,
    advice: 'Only needed for spoken interaction or phone calls; mark it not applicable otherwise.',
  },
  {
    id: 'email_inbox', title: 'Email Inbox', category: 'interfaces', impact: 'low', external: true,
    deps: ['imapflow', 'imap', 'node-imap', 'imap-simple', 'mailparser', 'imapclient', 'imaplib2', 'mail-listener2', 'postal-mime'],
    code: [/\bImapFlow\b|imaplib\.IMAP4|inbound[-_ ]?(email|mail|parse)|\/me\/(messages|mailFolders)|mailFolders\(|email\(\s*message\s*,/i],
    env: /IMAP|INBOUND_EMAIL|MAILBOX/,
    advice: 'Only needed if the system reads incoming email; mark it not applicable otherwise.',
  },
  {
    id: 'email_outbox', title: 'Email Outbox', category: 'interfaces', impact: 'medium', external: true,
    deps: ['nodemailer', 'resend', '@sendgrid/mail', 'sendgrid', 'postmark', 'mailgun.js', 'mailgun-js', '@aws-sdk/client-ses', '@aws-sdk/client-sesv2', '@react-email/components', 'react-email', 'email-templates', 'django-anymail', 'flask-mail', 'MailKit', 'SendGrid'],
    code: [/sendMail\(|\.emails\.send\(|sgMail\.send\(|smtplib\.SMTP|send_mail\(|SendEmailCommand|createTransport\(/],
    env: /SMTP|RESEND|SENDGRID|POSTMARK|MAILGUN|SES_|EMAIL_FROM|MAIL_FROM/,
    mentions: /\b(resend|sendgrid|postmark|mailgun|amazon ses|smtp)\b/i,
    advice: 'If the system must send email, choose a provider and set up sender verification (SPF, DKIM).',
  },
  {
    id: 'scheduled_jobs', title: 'Scheduled Jobs', category: 'interfaces', impact: 'medium', external: true,
    deps: ['node-cron', 'cron', 'croner', 'node-schedule', 'agenda', 'bull', 'bullmq', 'bree', 'celery', 'apscheduler', 'rq-scheduler', 'schedule', '@trigger.dev/sdk', 'inngest', 'sidekiq', 'whenever', 'Hangfire*', 'Quartz'],
    files: [/(^|\/)crontab$/, /(^|\/)(cron|jobs|schedulers?|workers?)\//i],
    code: [/cron\.schedule\(|new CronJob\(|@Cron\(|schedule\.every\(|"crons"\s*:|^\s*-\s*cron:\s*['"]|^\s*schedule:\s*$|@(app\.)?task\b|add_job\(|scheduleJob\(/m],
    advice: 'If work must run on a timetable (reminders, reports, clean-up), add a scheduler and monitor it.',
  },
  {
    id: 'webhooks', title: 'Webhooks', category: 'interfaces', impact: 'medium',
    deps: ['svix', '@octokit/webhooks', 'standardwebhooks'],
    files: [/(^|\/)webhooks?(\/|\.[cm]?[jt]sx?$|\.py$)/i],
    code: [/webhook/i, /constructEvent\(|verifySignature\(|X-Hub-Signature|svix-signature/i],
    advice: 'If other services must notify this system, add webhook endpoints that verify signatures.',
  },

  // Management
  {
    id: 'audit_log', title: 'Audit Log', category: 'management', impact: 'high',
    files: [/(^|\/)[^/]*audit[^/]*\.([cm]?[jt]sx?|py|rb|go|cs|java|php|sql|prisma)$/i],
    code: [/audit[_ ]?(log|event|trail|record)s?|auditLog|AuditEvent|append-only/i],
    advice: 'Record who did what and when for sensitive actions, in a log that cannot be edited.',
  },
  {
    id: 'models_agents', title: 'Models & Agents', category: 'management', impact: 'medium', external: true,
    deps: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-code', '@openai/agents', 'langgraph', '@langchain/langgraph', 'crewai', 'autogen', 'pyautogen', 'mastra', '@mastra/core', 'llamaindex'],
    files: [/(^|\/)(CLAUDE|AGENTS)\.md$/, /^\.claude\/(agents|skills|commands)\//, /(^|\/)agents?\/[^/]+\.([cm]?[jt]sx?|py|md|ya?ml)$/i, /(^|\/)prompts?\//i],
    code: [/model\s*[:=]\s*['"`](claude|gpt|gemini|o\d|llama|mistral)[^'"`]*['"`]/i, /system\s*[:=]\s*['"`]You are/],
    advice: 'If AI models or agents are used, keep a list of which ones, what they may do and who approves changes.',
  },
  {
    id: 'data_residency', title: 'Data Residency', category: 'management', impact: 'high', external: true, externalOnly: true,
    code: [/region\s*[:=]\s*['"`]?[a-z]{2}-[a-z]+-?\d?|europe-west\d|eu-(west|central|north)-\d|uksouth|ukwest|\blhr1\b|\bfra1\b|\bdub1\b|data[_ -]?residency/i],
    env: /REGION|LOCATION|DATA_RESIDENCY/,
    mentions: /data residency|hosted in the (UK|EU)|GDPR|UK GDPR|data protection/i,
    advice: 'Confirm with each provider where data is stored and processed, and write it down.',
  },
  {
    id: 'users', title: 'Users', category: 'management', impact: 'high', external: true,
    deps: ['next-auth', '@auth/*', 'passport', 'passport-*', '@clerk/*', '@auth0/*', 'auth0', 'firebase-admin', '@supabase/auth-helpers-nextjs', '@supabase/ssr', 'lucia', 'better-auth', '@azure/msal-node', '@azure/msal-browser', '@azure/msal-react', 'msal', 'django-allauth', 'flask-login', 'authlib', 'devise', 'omniauth', 'bcrypt', 'bcryptjs', 'argon2', 'jsonwebtoken', 'jose', 'Microsoft.Identity.Web'],
    files: [/(^|\/)(auth|login|signin|sign-in|users?|accounts?)(\/|\.[cm]?[jt]sx?$|\.py$)/i],
    code: [/signIn\(|getServerSession\(|auth\(\)|passport\.use\(|login_required|@login_required|bcrypt\.|argon2\.|jwt\.(sign|verify)\(|createUser\(|currentUser\b/],
    env: /NEXTAUTH|AUTH_SECRET|AUTH0|CLERK|AZURE_AD|ENTRA|MSAL|JWT_SECRET|SESSION_SECRET/,
    mentions: /\b(entra id|azure ad|auth0|clerk|single sign-on|sso|sign[- ]in)\b/i,
    advice: 'Decide how people sign in and what each role may do, then add sign-in and role checks.',
  },
  {
    id: 'settings', title: 'Settings', category: 'management', impact: 'low',
    files: [/(^|\/)(settings|preferences|config)(\/|\.[cm]?[jt]sx?$|\.py$|\.rb$)/i],
    code: [/(user|app|account|org(anisation|anization)?)[_ ]?(settings|preferences)\b|updateSetting\(|getSettings\(/i],
    advice: 'If people need to change how the app behaves, add a settings screen backed by stored settings.',
  },
];

export const CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);

const CODE_EXT = /\.([cm]?[jt]sx?|py|go|rb|php|java|kt|cs|rs|swift|vue|svelte|astro|sql|prisma|ya?ml|json|toml|tf|sh|ps1|graphql|gql)$|(^|\/)(Dockerfile|Procfile|Makefile|Jenkinsfile)$/;
const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$/i;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|_spec\.rb$|Tests?\.(cs|java|kt)$/;
const ENV_IN_CODE = [/process\.env\.([A-Z][A-Z0-9_]{1,63})/g, /process\.env\[['"]([A-Z][A-Z0-9_]{1,63})['"]\]/g, /import\.meta\.env\.([A-Z][A-Z0-9_]{1,63})/g, /os\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/g, /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/g, /ENV\[['"]([A-Z][A-Z0-9_]{1,63})['"]\]/g, /Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]{1,63})"/g, /System\.getenv\(\s*"([A-Z][A-Z0-9_]{1,63})"/g];
const ENV_FILE = /(^|\/)\.env(\.[a-z]+)?$/;
const MAX_EVIDENCE = 6;

/** What the evaluation looks things up in. Built once per assessment. */
export interface Index {
  snapshot: Snapshot;
  code: [string, string][];
  docs: [string, string][];
  /** Configuration names referenced in code or example env files, with where each was first seen. Names only, never values. */
  envNames: Map<string, string>;
}

export function buildIndex(snapshot: Snapshot): Index {
  const code: [string, string][] = [];
  const docs: [string, string][] = [];
  const envNames = new Map<string, string>();
  for (const [path, text] of snapshot.texts) {
    if (DOC_EXT.test(path)) docs.push([path, text]);
    else if (CODE_EXT.test(path) || CONFIG_FILE.test(path)) code.push([path, text]);
    if (ENV_FILE.test(path)) {
      text.split(/\r?\n/).forEach((line, i) => {
        const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=/.exec(line);
        if (m && !envNames.has(m[1]!)) envNames.set(m[1]!, `${path}:${i + 1}`);
      });
    } else if (CODE_EXT.test(path)) {
      for (const pattern of ENV_IN_CODE) {
        for (const m of text.matchAll(pattern)) if (!envNames.has(m[1]!)) envNames.set(m[1]!, `${path}:${lineOf(text, m.index!)}`);
      }
    }
  }
  return { snapshot, code, docs, envNames };
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function snippet(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return redactString(text.slice(start, end < 0 ? undefined : end).trim()).slice(0, 100);
}

function depMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  return p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p;
}

/** Up to MAX_EVIDENCE "path:line  text" hits for the patterns, and how many files matched in all. */
function search(files: [string, string][], patterns: RegExp[]): { hits: string[]; files: number } {
  const hits: string[] = [];
  let count = 0;
  for (const [path, text] of files) {
    for (const pattern of patterns) {
      const m = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text);
      if (!m) continue;
      count++;
      if (hits.length < MAX_EVIDENCE) hits.push(`${path}:${lineOf(text, m.index)}  ${snippet(text, m.index)}`);
      break;
    }
  }
  return { hits, files: count };
}

const more = (shown: number, total: number, what: string) => (total > shown ? [`…and ${total - shown} more ${what}`] : []);

export function evaluateCapability(cap: Capability, index: Index, notApplicable: boolean, credentialHits: string[] | null): CapabilityFinding {
  const base = { id: cap.id, title: cap.title, category: cap.category, impact: cap.impact };
  if (notApplicable) {
    return { ...base, status: 'not_applicable', confidence: 'high', evidence: ['Marked not applicable by you before the assessment ran.'], reasoning: 'You said this project does not need it, so nothing was searched.', externalState: null, nextAction: 'None, unless the project changes.' };
  }
  const s = index.snapshot;
  const deps = cap.deps ? s.dependencies.filter((d) => cap.deps!.some((p) => depMatches(p, d.name))) : [];
  const files = cap.files ? s.files.filter((f) => cap.files!.some((p) => p.test(f.path))) : [];
  const code = cap.code ? search(index.code, cap.code) : { hits: [], files: 0 };
  const env = cap.env ? [...index.envNames].filter(([name]) => cap.env!.test(name)) : [];
  const mentions = cap.mentions ? search(index.docs, [cap.mentions]) : { hits: [], files: 0 };

  const evidence: string[] = [];
  for (const d of deps.slice(0, MAX_EVIDENCE)) evidence.push(`Dependency "${d.name}" declared in ${d.source}${d.dev ? ' (development only)' : ''}`);
  evidence.push(...more(Math.min(deps.length, MAX_EVIDENCE), deps.length, 'dependencies'));
  for (const f of files.slice(0, MAX_EVIDENCE)) evidence.push(`File ${f.path}`);
  evidence.push(...more(Math.min(files.length, MAX_EVIDENCE), files.length, 'files'));
  evidence.push(...code.hits, ...more(code.hits.length, code.files, 'files with matching code'));
  for (const [name, at] of env.slice(0, MAX_EVIDENCE)) evidence.push(`Configuration name ${name} (${at})`);
  evidence.push(...mentions.hits.map((h) => `Mentioned in documentation: ${h}`));

  const runtimeDeps = deps.filter((d) => !d.dev);
  const kinds = [runtimeDeps.length > 0 || (deps.length > 0 && cap.id === 'code'), files.length > 0, code.files > 0].filter(Boolean).length;
  const strongWith = cap.strongWith ?? 2;
  const unread = s.skipped.filter((k) => k.reason === 'files beyond the reading limit').reduce((n, k) => n + k.count, 0);
  const externalState = cap.external ? ('not_verified' as const) : null;
  const outside = cap.external ? ' Its setup with the provider was not checked: the app has no connection to it.' : '';

  let status: CapabilityStatus;
  let confidence: Level;
  let reasoning: string;
  if (kinds >= strongWith) {
    status = 'implemented_in_code';
    confidence = kinds >= 2 || code.files >= 2 || files.length >= 2 ? 'high' : 'medium';
    reasoning = `Found ${describeKinds(runtimeDeps.length || deps.length, files.length, code.files)} in the repository.${outside}`;
  } else if (kinds >= 1) {
    status = 'partly_present';
    confidence = 'medium';
    reasoning =
      deps.length && !code.files && !files.length
        ? `A library is declared, but no code that uses it was found.${outside}`
        : !deps.length && cap.deps
          ? `Some code or files point to it, but no library for it is declared.${outside}`
          : `Only part of the usual evidence was found (${describeKinds(runtimeDeps.length || deps.length, files.length, code.files)}).${outside}`;
  } else if (deps.length || env.length || mentions.files) {
    status = 'not_verified';
    confidence = 'low';
    reasoning = deps.length
      ? 'Only a development dependency points to it, which does not show the product has it.'
      : 'Only names appear (configuration names or documentation). Names alone do not show that it exists or is connected.';
  } else if (cap.externalOnly) {
    status = 'not_verified';
    confidence = 'low';
    reasoning = 'This is usually set up outside the code, and nothing in the repository describes it.';
  } else {
    status = 'missing';
    confidence = unread > 0 ? 'low' : 'medium';
    reasoning = `No sign of it in ${index.code.length + index.docs.length} files read at commit ${s.commit.slice(0, 12)}${unread ? ` (${unread} files were beyond the reading limit)` : ''}.`;
  }
  if (cap.id === 'secrets' && credentialHits?.length) {
    // Committed credentials outweigh good habits elsewhere.
    status = status === 'implemented_in_code' ? 'partly_present' : status;
    confidence = 'high';
    evidence.unshift(...credentialHits.slice(0, MAX_EVIDENCE).map((h) => `Credential-shaped value at ${h} (value not shown)`), ...more(Math.min(credentialHits.length, MAX_EVIDENCE), credentialHits.length, 'lines with credential-shaped values'));
    reasoning = `${credentialHits.length} committed line(s) hold what looks like a credential. ${reasoning}`;
  }
  const tracked = cap.id === 'secrets' ? s.files.filter((f) => /(^|\/)\.env(\.(local|production|development))?$/.test(f.path)) : [];
  if (tracked.length) {
    if (status === 'implemented_in_code') status = 'partly_present';
    evidence.unshift(...tracked.slice(0, MAX_EVIDENCE).map((f) => `Environment file ${f.path} is committed`));
    reasoning = `An environment file is committed to the repository. ${reasoning}`;
  }
  if (!evidence.length) evidence.push(`Searched ${index.code.length} code and configuration files and ${index.docs.length} documents at commit ${s.commit.slice(0, 12)}: nothing matched.`);

  return { ...base, status, confidence, evidence, reasoning, externalState: status === 'missing' ? null : externalState, nextAction: nextAction(cap, status, credentialHits?.length ?? 0, tracked.length) };
}

function describeKinds(deps: number, files: number, code: number): string {
  const parts = [deps && `${deps} declared ${deps === 1 ? 'library' : 'libraries'}`, files && `${files} matching ${files === 1 ? 'file' : 'files'}`, code && `matching code in ${code} ${code === 1 ? 'file' : 'files'}`].filter(Boolean);
  return parts.join(', ') || 'nothing';
}

function nextAction(cap: Capability, status: CapabilityStatus, credentials: number, envFiles: number): string {
  if (cap.id === 'secrets' && (credentials || envFiles)) {
    return 'Treat the flagged values as exposed: revoke and replace them with the provider, remove them from the repository and its history, and read them from the environment instead.';
  }
  switch (status) {
    case 'implemented_in_code':
      return cap.external ? `Confirm with the provider that ${cap.title} is set up as the code expects; the app cannot check this yet.` : 'Nothing needed now. Read the evidence before relying on it.';
    case 'partly_present':
      return `Check whether ${cap.title} is finished or left over. ${cap.advice}`;
    case 'not_verified':
      return `Find out whether ${cap.title} exists outside the code, and record the answer. ${cap.advice}`;
    case 'missing':
      return `${cap.advice} If the project does not need it, mark it not applicable next time.`;
    default:
      return 'None.';
  }
}

// ---- Codebase summary (structure, stack, dependencies, tests, configuration, documentation) ----

export interface CodebaseSummary {
  structure: { files: number; topLevel: { name: string; files: number }[]; languages: { language: string; files: number }[] };
  stack: { name: string; evidence: string }[];
  dependencies: { ecosystem: string; runtime: number; dev: number; manifests: string[]; lockfile: string | null }[];
  tests: { files: number; examples: string[]; frameworks: string[]; scripts: string[] };
  configuration: { item: string; evidence: string }[];
  documentation: { item: string; evidence: string }[];
}

const LANGUAGES: [RegExp, string][] = [
  [/\.tsx?$|\.[cm]ts$/, 'TypeScript'],
  [/\.jsx?$|\.[cm]js$/, 'JavaScript'],
  [/\.py$/, 'Python'],
  [/\.go$/, 'Go'],
  [/\.rs$/, 'Rust'],
  [/\.rb$/, 'Ruby'],
  [/\.php$/, 'PHP'],
  [/\.(java|kt)$/, 'Java/Kotlin'],
  [/\.cs$/, 'C#'],
  [/\.swift$/, 'Swift'],
  [/\.(c|h|cc|cpp|hpp)$/, 'C/C++'],
  [/\.vue$/, 'Vue'],
  [/\.svelte$/, 'Svelte'],
  [/\.(css|scss|sass|less)$/, 'Stylesheets'],
  [/\.html?$/, 'HTML'],
  [/\.sql$/, 'SQL'],
  [/\.(sh|ps1|bat)$/, 'Shell scripts'],
  [/\.(md|mdx|rst|txt)$/i, 'Documentation'],
];

const FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['nuxt', 'Nuxt'], ['svelte', 'Svelte'], ['@sveltejs/kit', 'SvelteKit'], ['@angular/core', 'Angular'], ['astro', 'Astro'],
  ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['hono', 'Hono'], ['koa', 'Koa'], ['electron', 'Electron'], ['react-native', 'React Native'], ['expo', 'Expo'],
  ['typescript', 'TypeScript'], ['tailwindcss', 'Tailwind CSS'], ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['drizzle-orm', 'Drizzle ORM'], ['vite', 'Vite'],
  ['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['rails', 'Ruby on Rails'], ['laravel/framework', 'Laravel'], ['spring-boot-starter*', 'Spring Boot'],
  ['github.com/gin-gonic/gin', 'Gin'], ['actix-web', 'Actix Web'], ['axum', 'Axum'], ['Microsoft.AspNetCore*', 'ASP.NET Core'],
];

const TEST_FRAMEWORKS = ['jest', 'vitest', 'mocha', 'ava', 'tap', 'jasmine', '@playwright/test', 'playwright', 'cypress', '@testing-library/*', 'supertest', 'pytest', 'unittest2', 'nose2', 'hypothesis', 'rspec', 'minitest', 'phpunit/phpunit', 'junit*', 'xunit*', 'nunit*'];

export function summarizeCodebase(index: Index): CodebaseSummary {
  const s = index.snapshot;
  const top = new Map<string, number>();
  for (const f of s.files) {
    const name = f.path.includes('/') ? `${f.path.split('/')[0]}/` : '(top-level files)';
    top.set(name, (top.get(name) ?? 0) + 1);
  }
  const langs = new Map<string, number>();
  for (const f of s.files) {
    const hit = LANGUAGES.find(([re]) => re.test(f.path));
    if (hit) langs.set(hit[1], (langs.get(hit[1]) ?? 0) + 1);
  }

  const stack: CodebaseSummary['stack'] = [];
  for (const [dep, name] of FRAMEWORKS) {
    const d = s.dependencies.find((x) => depMatches(dep, x.name));
    if (d && !stack.some((x) => x.name === name)) stack.push({ name, evidence: `"${d.name}" in ${d.source}` });
  }
  const nodeVersion = s.texts.get('.nvmrc')?.trim() ?? s.texts.get('.node-version')?.trim();
  if (nodeVersion) stack.push({ name: `Node.js ${nodeVersion.slice(0, 20)}`, evidence: s.texts.has('.nvmrc') ? '.nvmrc' : '.node-version' });

  const byEco = new Map<string, CodebaseSummary['dependencies'][number]>();
  for (const d of s.dependencies) {
    const e = byEco.get(d.ecosystem) ?? { ecosystem: d.ecosystem, runtime: 0, dev: 0, manifests: [], lockfile: null };
    if (d.dev) e.dev++;
    else e.runtime++;
    if (!e.manifests.includes(d.source)) e.manifests.push(d.source);
    byEco.set(d.ecosystem, e);
  }
  const LOCKS: Record<string, RegExp> = { npm: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/, python: /(^|\/)(poetry\.lock|Pipfile\.lock|uv\.lock)$/, go: /(^|\/)go\.sum$/, rust: /(^|\/)Cargo\.lock$/, ruby: /(^|\/)Gemfile\.lock$/, php: /(^|\/)composer\.lock$/, dotnet: /(^|\/)packages\.lock\.json$/ };
  for (const e of byEco.values()) e.lockfile = s.files.find((f) => LOCKS[e.ecosystem]?.test(f.path))?.path ?? null;

  const testFiles = s.files.filter((f) => TEST_FILE.test(f.path) && !/\.(md|json|snap|txt|png|jpe?g)$/i.test(f.path));
  const scripts: string[] = [];
  for (const m of s.manifests.filter((p) => p.endsWith('package.json'))) {
    try {
      const pkg = JSON.parse(s.texts.get(m)!) as { scripts?: Record<string, unknown> };
      for (const [k, v] of Object.entries(pkg.scripts ?? {})) if (/test|e2e|spec/i.test(k) && typeof v === 'string') scripts.push(`${m}: ${k} = ${redactString(v).slice(0, 80)}`);
    } catch {
      // Already listed as unreadable.
    }
  }

  const configuration: CodebaseSummary['configuration'] = [];
  const firstFile = (re: RegExp) => s.files.find((f) => re.test(f.path))?.path;
  const addConfig = (item: string, re: RegExp) => {
    const at = firstFile(re);
    if (at) configuration.push({ item, evidence: at });
  };
  addConfig('Continuous integration', /^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^Jenkinsfile$|^azure-pipelines\.ya?ml$|^\.circleci\/config\.yml$/);
  addConfig('Container', /(^|\/)Dockerfile$|(^|\/)(docker-)?compose[^/]*\.ya?ml$/);
  addConfig('Hosting configuration', /^(vercel\.json|netlify\.toml|fly\.toml|render\.ya?ml|app\.ya?ml|Procfile|serverless\.ya?ml|wrangler\.toml|railway\.(json|toml))$|\.tf$/);
  addConfig('Type checking', /(^|\/)(tsconfig\.json|mypy\.ini|pyrightconfig\.json)$/);
  addConfig('Linting', /(^|\/)(\.eslintrc(\.[a-z]+)?|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|ruff\.toml|\.flake8|\.pylintrc|\.rubocop\.yml|\.golangci\.ya?ml)$/);
  addConfig('Formatting', /(^|\/)(\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?[jt]s|\.editorconfig|rustfmt\.toml)$/);
  addConfig('Example environment file', /(^|\/)\.env\.(example|sample|template|dist)$/);
  addConfig('Dependency updates', /^\.github\/dependabot\.yml$|^renovate\.json5?$|^\.renovaterc(\.json)?$/);
  if (index.envNames.size) configuration.push({ item: `${index.envNames.size} configuration ${index.envNames.size === 1 ? 'name' : 'names'} read from the environment`, evidence: [...index.envNames.keys()].slice(0, 8).join(', ') + (index.envNames.size > 8 ? ', …' : '') });

  const documentation: CodebaseSummary['documentation'] = [];
  const addDoc = (item: string, re: RegExp) => {
    const at = firstFile(re);
    if (at) documentation.push({ item, evidence: at === 'README.md' || at === 'README' ? `${at} (${(s.texts.get(at) ?? '').length.toLocaleString('en-GB')} characters)` : at });
  };
  addDoc('README', /^README(\.[a-z]+)?$/i);
  const docsFolder = s.files.filter((f) => /^docs?\//i.test(f.path)).length;
  if (docsFolder) documentation.push({ item: 'Documentation folder', evidence: `${docsFolder} files under docs/` });
  addDoc('Licence', /^(LICEN[CS]E|COPYING)(\.[a-z]+)?$/i);
  addDoc('Changelog', /^CHANGELOG(\.[a-z]+)?$/i);
  addDoc('Contributing guide', /^(\.github\/)?CONTRIBUTING(\.[a-z]+)?$/i);
  addDoc('Security policy', /^(\.github\/)?SECURITY(\.[a-z]+)?$/i);
  addDoc('Architecture notes', /(^|\/)(ARCHITECTURE|DESIGN|ADR)[^/]*\.md$|(^|\/)adr\//i);

  return {
    structure: {
      files: s.files.length,
      topLevel: [...top].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files).slice(0, 15),
      languages: [...langs].map(([language, files]) => ({ language, files })).sort((a, b) => b.files - a.files),
    },
    stack,
    dependencies: [...byEco.values()],
    tests: {
      files: testFiles.length,
      examples: testFiles.slice(0, 5).map((f) => f.path),
      frameworks: [...new Set(s.dependencies.filter((d) => TEST_FRAMEWORKS.some((p) => depMatches(p, d.name))).map((d) => d.name))],
      scripts,
    },
    configuration,
    documentation,
  };
}

/** Findings about the codebase as a whole, each with evidence, confidence, impact and a next action. */
export function codebaseObservations(summary: CodebaseSummary, index: Index, credentialHits: string[] | null): Observation[] {
  const s = index.snapshot;
  const out: Observation[] = [];
  if (credentialHits?.length) {
    out.push({
      title: 'Credential-shaped values are committed',
      evidence: credentialHits.slice(0, MAX_EVIDENCE).map((h) => `${h} (value not shown${TEST_FILE.test(h.replace(/:\d+$/, '')) ? '; a test file, so it may be a fake value' : ''})`).concat(more(Math.min(credentialHits.length, MAX_EVIDENCE), credentialHits.length, 'lines')),
      confidence: 'medium',
      impact: 'high',
      nextAction: 'Check each line. Treat real values as exposed: revoke and replace them, then remove them from the repository and its history.',
    });
  }
  const envFiles = s.files.filter((f) => /(^|\/)\.env(\.(local|production|development))?$/.test(f.path));
  if (envFiles.length) out.push({ title: 'An environment file is committed', evidence: envFiles.slice(0, MAX_EVIDENCE).map((f) => `File ${f.path}`), confidence: 'high', impact: 'high', nextAction: 'Remove it from the repository, add it to .gitignore, and commit a .env.example with names only.' });
  if (!summary.tests.files) {
    out.push({ title: 'No tests were found', evidence: [`None of the ${s.files.length} files at commit ${s.commit.slice(0, 12)} look like tests (for example *.test.ts, tests/, test_*.py).`], confidence: 'medium', impact: 'high', nextAction: 'Add tests for the most important behaviour before changing the code.' });
  } else if (!summary.tests.scripts.length && summary.dependencies.some((d) => d.ecosystem === 'npm')) {
    out.push({ title: 'Tests exist but no test script is declared', evidence: summary.tests.examples.map((p) => `File ${p}`), confidence: 'medium', impact: 'medium', nextAction: 'Add a "test" script to package.json so the tests can be run the same way everywhere.' });
  }
  if (!summary.configuration.some((c) => c.item === 'Continuous integration')) {
    out.push({ title: 'No continuous integration configuration', evidence: ['No .github/workflows, .gitlab-ci.yml, Jenkinsfile, azure-pipelines.yml or .circleci/config.yml at this commit.'], confidence: 'high', impact: 'medium', nextAction: 'Run the tests automatically on every change.' });
  }
  for (const d of summary.dependencies) {
    if (!d.lockfile && d.runtime + d.dev > 0 && ['npm', 'python', 'rust', 'ruby', 'php'].includes(d.ecosystem)) {
      out.push({ title: `No lockfile for ${d.ecosystem} dependencies`, evidence: d.manifests.map((m) => `Manifest ${m}`), confidence: 'high', impact: 'medium', nextAction: 'Commit a lockfile so every install gets the same dependency versions.' });
    }
  }
  if (!summary.documentation.some((d) => d.item === 'README')) out.push({ title: 'No README', evidence: ['No README at the top of the repository.'], confidence: 'high', impact: 'medium', nextAction: 'Add a README that says what the project does and how to run it.' });
  if (s.unreadableManifests.length) out.push({ title: 'Some manifests could not be read', evidence: s.unreadableManifests.map((m) => `Manifest ${m}`), confidence: 'high', impact: 'low', nextAction: 'Check these files are valid; their dependencies are missing from this report.' });
  return out;
}
