const jwt = require("jsonwebtoken");
const pool = require("../db");

module.exports = (req, res, next) => {
  //Middleware to check if a user is signed in
  const { authorization } = req.headers;

  if (!authorization) {
    return res.status(401).send({ error: "You must be logged in" });
  }
  const token = authorization.replace("Bearer ", "");
  jwt.verify(token, process.env.SECRET_KEY, async (err, payload) => {
    if (err) {
      return res.status(401).send({ error: "You must be logged in" });
    }
    const { userId } = payload;
    //retrieve user from database
    const user = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
    req.user = user.rows[0];
    next();
  });
};
