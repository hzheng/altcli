# Shared contracts

`openapi.yaml` describes the current JSON HTTP boundary. TypeScript types live in
`web/src/contracts/api.ts`. They are deliberately free of React/Node/SQLite imports.

The schema and types are maintained together manually for this scaffold. There is
no generated Swift code or claim of automatic schema/type consistency. Add contract
validation/code generation before freezing a native-client API. Future structured
handoff events require a separate protocol; they are not currently ingested.
