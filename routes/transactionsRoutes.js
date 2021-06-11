const pool = require("../db");
const dayjs = require("dayjs");
const requireAuth = require("../middleware/requireAuth");
const express = require("express");
const router = express.Router();

/**
 * Posts a user transaction for the current budget period and then returns all the transaction for the period
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { category, amount, note, date, budget_period_id, transaction_type, icon, colour } = req.body;
    date = dayjs(date);

    //insert the new transaction into transactions table
    await pool.query(
      "INSERT INTO transactions (category, amount, note, date, transaction_type, user_id, budget_period_id, icon, colour) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [category, amount, note, date, transaction_type, user_id, budget_period_id, icon, colour]
    );

    //retrieve all the transactions of current budget period for the given user
    let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND budget_period_id=$2", [
      user_id,
      budget_period_id,
    ]);
    transactions = transactions.rows;
    console.log("TRANSACTIONS", transactions);
    return res.status(200).send({ transactions });
  } catch (error) {
    console.log(error.message);
    return res
      .status(400)
      .send({ error: "Unable to add the transaction to the specfied budget period, please try again" });
  }
});

/**
 * Deletes a transaction
 */
router.delete("/", requireAuth, async (req, res) => {
  try {
    const { transaction_id, budget_period_id } = req.body;
    console.log(transaction_id, budget_period_id);
    const user_id = req.user.id;
    await pool.query("DELETE FROM transactions WHERE id=$1", [transaction_id]);

    let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND  budget_period_id=$2", [
      user_id,
      budget_period_id,
    ]);
    transactions = transactions.rows;
    console.log("TRANSACTIONS", transactions);
    return res.status(200).send({ transactions });
  } catch (error) {
    console.log(error.message);
    return res
      .status(400)
      .send({ error: "Unable to delete the transaction from the specfied budget period, please try again" });
  }
});

/**
 * Gets the transaction habits of a user for the given budget period
 */
router.get("/habits/:budgetPeriodId", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const budgetPeriodId = req.params.budgetPeriodId;
    console.log(user_id, budgetPeriodId);

    //retrieve the transactions that are expenses of the user and group them by category
    let expenseHabits = await pool.query(
      "SELECT category, SUM(amount) FROM transactions WHERE user_id=$1 AND budget_period_id=$2 AND transaction_type=$3 GROUP BY category",
      [user_id, budgetPeriodId, "expense"]
    );
    expenseHabits = expenseHabits.rows;

    //We have to retrieve the icon and colour for each expense category
    for (let i = 0; i < expenseHabits.length; i++) {
      let item = expenseHabits[i];
      let result = await pool.query(
        "SELECT icon, colour FROM transactions WHERE user_id=$1 AND budget_period_id=$2 AND category=$3",
        [user_id, budgetPeriodId, item.category]
      );
      const { icon, colour } = result.rows[0];
      expenseHabits[i] = { ...item, icon, colour };
    }

    //do the same thing but for transactions that are earnings
    let earningHabits = await pool.query(
      "SELECT category, SUM(amount) FROM transactions WHERE user_id=$1 AND budget_period_id=$2 AND transaction_type=$3 GROUP BY category",
      [user_id, budgetPeriodId, "earning"]
    );
    earningHabits = earningHabits.rows;

    //We have to retrieve the icon and colour for each earning category
    for (let i = 0; i < earningHabits.length; i++) {
      let item = earningHabits[i];
      let result = await pool.query(
        "SELECT icon, colour FROM transactions WHERE user_id=$1 AND budget_period_id=$2 AND category=$3",
        [user_id, budgetPeriodId, item.category]
      );
      const { icon, colour } = result.rows[0];
      earningHabits[i] = { ...item, icon, colour };
    }

    //get the period start_date so we can search for the next and previous budget periods
    let currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [budgetPeriodId]);
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    const { start_date, end_date } = currentBudgetPeriod;

    let nextBudgetPeriodId = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, end_date]
    );
    nextBudgetPeriodId = nextBudgetPeriodId.rows[0] ? nextBudgetPeriodId.rows[0].id : null;

    let previousBudgetPeriodId = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date < $2 ORDER BY end_date DESC LIMIT 1",
      [user_id, end_date]
    );
    previousBudgetPeriodId = previousBudgetPeriodId.rows[0] ? previousBudgetPeriodId.rows[0].id : null;

    //get the transactions of the selected budget period
    let transactions = await pool.query("SELECT * FROM transactions WHERE user_id=$1 AND budget_period_id=$2", [
      user_id,
      currentBudgetPeriod.id,
    ]);

    transactions = transactions.rows;
    console.log("CURRENT BUDGET PERIOD", currentBudgetPeriod);
    console.log("Transactions", transactions);
    return res.status(200).send({
      earningHabits,
      expenseHabits,
      currentBudgetPeriod,
      previousBudgetPeriodId,
      nextBudgetPeriodId,
      transactions,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve transaction habits, please try again" });
  }
});

/**
 * Get the transaction habits for a single category (For ex. Eat/Drink ) in the selected budget period.
 */
router.get("/habits", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { category, budgetPeriodId } = req.query;
    console.log(category, budgetPeriodId);

    //get the transactions that are of the selected category and budget period
    let transactions = await pool.query(
      "SELECT * FROM transactions WHERE user_id =$1 AND category = $2 AND budget_period_id =$3",
      [user_id, category, budgetPeriodId]
    );
    transactions = transactions.rows;

    //get the current, next and previous budget period
    let currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [budgetPeriodId]);
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    const { start_date, end_date } = currentBudgetPeriod;

    let nextBudgetPeriodId = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, end_date]
    );
    nextBudgetPeriodId = nextBudgetPeriodId.rows[0] ? nextBudgetPeriodId.rows[0].id : null;

    let previousBudgetPeriodId = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date < $2 ORDER BY end_date DESC LIMIT 1",
      [user_id, end_date]
    );
    previousBudgetPeriodId = previousBudgetPeriodId.rows[0] ? previousBudgetPeriodId.rows[0].id : null;

    //Get the amount spent for the category in the previous budget period
    let previousAmountSpent = await pool.query(
      "SELECT SUM(amount) FROM transactions WHERE user_id =$1 AND budget_period_id=$2 AND category=$3",
      [user_id, previousBudgetPeriodId, category]
    );
    console.log(previousAmountSpent.rows[0]);
    previousAmountSpent = previousAmountSpent.rows[0].sum !== null ? previousAmountSpent.rows[0].sum : 0;

    //get the amount spent for the category in the current period
    let currentAmountSpent = await pool.query(
      "SELECT SUM(amount) FROM transactions WHERE user_id =$1 AND budget_period_id=$2 AND category=$3",
      [user_id, budgetPeriodId, category]
    );
    console.log(currentAmountSpent.rows[0]);
    currentAmountSpent = currentAmountSpent.rows[0].sum !== null ? currentAmountSpent.rows[0].sum : 0;

    //then calculate the difference between the amount spent in the previous and current periods
    let monthlyDifference;
    if (previousAmountSpent === 0) {
      monthlyDifference = "N/A";
    } else {
      monthlyDifference = ((currentAmountSpent - previousAmountSpent) / Math.abs(previousAmountSpent)) * 100;
    }
    console.log(previousBudgetPeriodId, budgetPeriodId, nextBudgetPeriodId);
    console.log(previousAmountSpent, currentAmountSpent, monthlyDifference);
    return res
      .status(200)
      .send({ transactions, currentBudgetPeriod, previousBudgetPeriodId, nextBudgetPeriodId, monthlyDifference });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve transactions for this category, please try again" });
  }
});

module.exports = router;
