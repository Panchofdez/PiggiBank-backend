const pool = require("../db");
const dayjs = require("dayjs");
const requireAuth = require("../middleware/requireAuth");
const express = require("express");
const router = express.Router();

/**
 * Route to add a user's fixed income
 */
router.post("/income", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { income, startDate, currentBudgetPeriodId } = req.body;
    startDate = dayjs(startDate);
    let user = await pool.query("UPDATE users SET income=$1 WHERE id = $2 RETURNING *", [income, user_id]);
    user = user.rows[0];

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum === null ? 0 : fixedSpendingTotal.rows[0].sum;
    //we have to recalculate the total budget
    const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);
    await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND end_date > $3", [
      totalBudget,
      user_id,
      startDate,
    ]);

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriodId]);
    return res.status(200).send({
      currentBudgetPeriod: currentBudgetPeriod.rows[0],
      income: user.income,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to set budget income, please try again" });
  }
});

/**
 * Add a user's fixed savings
 */
router.post("/savings", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { savings, startDate, currentBudgetPeriodId } = req.body;
    startDate = dayjs(startDate);
    let user = await pool.query("UPDATE users SET savings=$1 WHERE id=$2 RETURNING *", [savings, user_id]);
    user = user.rows[0];

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum === null ? 0 : fixedSpendingTotal.rows[0].sum;
    //we have to recalculate the total budget
    const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);

    //update current and future budget periods
    await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND end_date > $3", [
      totalBudget,
      user_id,
      startDate,
    ]);

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriodId]);
    return res.status(200).send({ currentBudgetPeriod: currentBudgetPeriod.rows[0], savings: user.savings });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to set budget savings, please try again" });
  }
});

/**Get all the fixed expenses
 *
 */
router.get("/fixedexpenses", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const result = await pool.query("SELECT * FROM fixed_expenses WHERE user_id=$1", [user_id]);
    const fixed_expenses = result.rows;
    return res.status(200).send({ fixed_expenses });
  } catch (error) {
    console.error(error.message);
    return res.status(400).send({ error: "Unable to retrieve fixed expenses, please try again" });
  }
});

/**
 * Adds a users fixed expenses by deleting the previous expenses and replacing them with the new fixed spending list
 */
router.post("/fixedexpenses", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { fixedSpendingList, startDate, currentBudgetPeriodId } = req.body;

    //reset all the users fixed expenses
    await pool.query("DELETE FROM fixed_expenses WHERE user_id=$1", [user_id]);

    for (let i = 0; i < fixedSpendingList.length; i++) {
      let expense = fixedSpendingList[i];
      await pool.query("INSERT INTO fixed_expenses (title, amount, user_id) VALUES($1, $2, $3)", [
        expense.title,
        expense.amount,
        user_id,
      ]);
    }

    //retrieve the user
    let user = await pool.query("SELECT income, savings FROM users WHERE id = $1", [user_id]);
    const { income, savings } = user.rows[0];

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum === null ? 0 : fixedSpendingTotal.rows[0].sum;

    //we have to recalculate the total budget
    const totalBudget = getTotalBudget(income, fixedSpendingTotal, savings);
    await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND end_date > $3", [
      totalBudget,
      user_id,
      startDate,
    ]);

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriodId]);

    let newFixedSpendingList = await pool.query("SELECT * FROM fixed_expenses WHERE user_id=$1", [user_id]);

    return res.status(200).send({
      currentBudgetPeriod: currentBudgetPeriod.rows[0],
      fixedSpendingTotal,
      fixedSpendingList: newFixedSpendingList.rows,
    });
  } catch (error) {
    console.error(error.message);
    return res.status(400).send({ error: "Unable to add fixed expenses, please try again" });
  }
});

/**
 * Calculates a user's initial budget based on the fixed income, spending and savings
 * @param {*} income
 * @param {*} fixedSpending
 * @param {*} savings
 * @returns the initial total budget
 */
const getTotalBudget = (income, fixedSpending, savings) => {
  return income - fixedSpending - (income - fixedSpending) * (savings / 100);
};

module.exports = router;
