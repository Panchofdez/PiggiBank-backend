const pool = require("../db");
const requireAuth = require("../middleware/requireAuth");
const express = require("express");
const router = express.Router();

/**
 * Retrieve all the relevant information about the user
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let user = await pool.query("SELECT income, savings, created_budget FROM users WHERE id=$1", [user_id]);
    user = user.rows[0];
    let fixedSpendingList = await pool.query("SELECT * FROM fixed_expenses WHERE user_id=$1", [user_id]);
    fixedSpendingList = fixedSpendingList.rows;
    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum === null ? 0 : fixedSpendingTotal.rows[0].sum;

    return res.status(200).send({ ...user, fixedSpendingList, fixedSpendingTotal });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve user information" });
  }
});

/**
 * updates a user to have created the initial budget set to true. This signifies that the inital budget creation process is done
 */
router.post("/createdbudget", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;

    let user = await pool.query("UPDATE users SET created_budget=$1 WHERE id=$2 RETURNING *", [true, user_id]);
    user = user.rows[0];
    return res.status(200).send({
      email: user.email,
      income: user.income,
      savings: user.savings,
      createdBudget: user.created_budget,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "Unable to update user information" });
  }
});

module.exports = router;
