# GearNest Server

The backend API for **GearNest**, an equipment rental platform. The
server handles API requests and business logic for users, equipment,
bookings, and platform workflows.

> This README is a starting template based on the GearNest project
> requirements discussed during development. Verify environment-variable
> names, endpoints, and implemented modules against the current source
> code before publishing.

## Tech Stack

-   Node.js
-   Express.js
-   TypeScript (if enabled in this repository)
-   MongoDB
-   Better Auth/JWT authentication integration, according to the current
    configuration
-   Stripe payments, if integrated
-   ImgBB image hosting, if integrated

## Responsibilities

The backend is intended to support:

-   Equipment listing and detail APIs.
-   Authentication and protected routes.
-   Role-based authorization for customers, owners, and administrators.
-   Booking and rental-request workflows.
-   Owner-scoped equipment and rental management.
-   Administrative management and analytics.
-   Payment processing and image uploads where those integrations are
    enabled.

Only describe a feature as active once it is implemented and configured.

## User Roles

  Role      Typical access
  --------- -------------------------------------------------------------
  `admin`   Platform-wide administration
  `owner`   Manage owned equipment and incoming rental requests
  `user`    Browse equipment and manage personal bookings and favorites

The backend must enforce authorization. Frontend route protection alone
is not sufficient.

## Getting Started

### Prerequisites

-   Node.js (use the version supported by the project)
-   npm, pnpm, yarn, or bun
-   MongoDB or MongoDB Atlas
-   Credentials for enabled external services

### Installation

``` bash
git clone <SERVER_REPOSITORY_URL>
cd <SERVER_PROJECT_DIRECTORY>
npm install
```

### Environment Variables

Create a `.env` file in the server root. The following is an
illustrative checklist, not a guarantee of the exact names used by your
code:

``` env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>/<database>
CLIENT_URL=http://localhost:3000

# Add the authentication settings required by your implementation.
# Examples may include Better Auth URL, JWT/JWKS settings,
# Google OAuth credentials, or trusted origins.

# Add only if Stripe is integrated:
# STRIPE_SECRET_KEY=

# Add only if ImgBB is integrated:
# IMGBB_API_KEY=
```

Use the exact variable names referenced in the source code. Never commit
`.env`. Keep database credentials, OAuth secrets, Stripe secret keys,
and JWT secrets on the server only. Configure production values in the
hosting provider's environment settings.

### Run Locally

Use the scripts defined in `package.json`. A common development command
is:

``` bash
npm run dev
```

If that script is not present, inspect `package.json` and use the
configured command.

### Build and Start

For a TypeScript project, scripts may look like:

``` bash
npm run build
npm start
```

Confirm the actual scripts in `package.json`.

## API Modules

Document the actual routes in this repository. Typical modules include:

  Module           Responsibility
  ---------------- --------------------------------------------
  Authentication   Verify sessions or tokens
  Users            Profile and account management
  Equipment        Browse and manage equipment listings
  Bookings         Create and manage rental bookings
  Favorites        Save and retrieve customer favorites
  Owner            Owner dashboard and rental management
  Admin            Platform administration and analytics
  Payments         Checkout and payment status, if integrated

For each implemented endpoint, document its HTTP method, path,
authentication requirement, request schema, and response.

## Authentication and Authorization

Use the authentication mechanism already configured in the project.

Recommended request flow:

1.  Verify the incoming session or token.
2.  Attach the verified user identity and role to request context.
3.  Apply role authorization middleware.
4.  Check resource ownership before accessing private resources.
5.  Execute the controller/service operation.

Example pattern; adapt names to the actual code:

``` ts
router.get(
  "/admin/dashboard",
  verifyToken,
  authorizeRoles("admin"),
  getAdminDashboard
);

router.get(
  "/owner/dashboard",
  verifyToken,
  authorizeRoles("owner"),
  getOwnerDashboard
);
```

### Authorization Rules

-   Derive identity and role from verified authentication data.
-   Never trust a role, owner ID, or customer ID supplied in the request
    body or query string for authorization.
-   Owners may only manage resources they own.
-   Customers may only access their own private bookings, favorites, and
    profile data.
-   Protect admin operations with server-side role checks.
-   Validate inputs and return appropriate `401`, `403`, and `404`
    responses.

## Database

The application uses MongoDB. Document the actual database, collection,
and model names from the implementation.

Recommended practices:

-   Validate data before database writes.
-   Add indexes for frequently queried fields where appropriate.
-   Scope private queries by the authenticated user's ID.
-   Maintain consistent references between users, equipment, bookings,
    and payments.
-   Handle missing related records safely.
-   Keep booking status, equipment approval status, availability status,
    and payment status separate.

## Payments

If Stripe is integrated:

-   Keep secret keys on the server.
-   Verify webhook signatures.
-   Do not trust a payment-success state sent by the client.
-   Update payment records only after validating the provider response
    or webhook.
-   Keep payment status separate from booking status.
-   Calculate owner earnings and platform revenue according to the
    actual payout/fee model.

## Image Uploads

If ImgBB is integrated:

-   Keep the API key on the server.
-   Validate file type and size.
-   Handle upload failures.
-   Store the returned image URL in the appropriate database record.

## CORS

Allow only the frontend origins used by the application. Local
development may require:

``` text
http://localhost:3000
```

Add the exact deployed frontend origin for production. If authentication
uses cookies, configure credentials and cookie settings correctly. Avoid
wildcard origins with credentialed requests.

## Deployment Checklist

1.  Deploy the server to the selected hosting provider.
2.  Configure production environment variables.
3.  Add the deployed frontend origin to the CORS allowlist.
4.  Configure MongoDB network access and credentials securely.
5.  Configure authentication URLs, trusted origins, and OAuth callbacks.
6.  Configure payment webhooks and image-hosting credentials if those
    integrations are enabled.
7.  Test public and protected endpoints after deployment.

## Suggested Structure

The actual repository may differ.

``` text
src/
├── config/
├── middlewares/
├── modules/
│   ├── users/
│   ├── equipment/
│   ├── bookings/
│   ├── favorites/
│   ├── payments/
│   ├── owner/
│   └── admin/
├── routes/
├── services/
├── types/
├── utils/
└── app.ts
```

## Error Handling and Validation

-   Validate route parameters, query strings, and request bodies.
-   Use centralized error handling where possible.
-   Do not expose stack traces or secrets in production responses.
-   Use consistent response structures and meaningful HTTP status codes.
-   Never log passwords, tokens, or payment secrets.

## Troubleshooting

  -----------------------------------------------------------------------
  Problem                             Check
  ----------------------------------- -----------------------------------
  Database connection fails           `MONGODB_URI`, network access,
                                      credentials

  Frontend cannot call API            Backend URL, CORS, server health,
                                      route path

  `401 Unauthorized`                  Token/session verification

  `403 Forbidden`                     Role middleware and ownership
                                      checks

  Google OAuth callback fails         Auth handler URL, exact OAuth
                                      redirect URI, client credentials,
                                      trusted origins

  Payment webhook fails               Public webhook URL, signing secret,
                                      raw-body/signature handling

  Image upload fails                  ImgBB key, upload limits, provider
                                      response
  -----------------------------------------------------------------------

## License

Add the license and usage terms applicable to this project.
