const Pool = require("pg").Pool;

const devConfig = {
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  database: process.env.POSTGRES_DATABASE,
};

const prodConfig = {
  connectionString: process.env.DATABASE_URL,
};

const pool = new Pool(process.env.NODE_ENV === "production" ? prodConfig : devConfig);

module.exports = pool;
