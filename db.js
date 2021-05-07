const Pool = require("pg").Pool;

const pool = new Pool({
  user: "postgres",
  password: "SpicyP#13",
  host: "localhost",
  port: 5432,
  database: "budgeting_app",
});

module.exports = pool;
