import postgres from "postgres";
const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://campusops@127.0.0.1:55432/campusops_dev",
  { max: 1 },
);
await sql.unsafe("drop schema public cascade; create schema public;");
await sql.end();
console.log("dev schema reset");
