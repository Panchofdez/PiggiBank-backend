const pool = require("../db");
const dayjs = require("dayjs");
const requireAuth = require("../middleware/requireAuth");
const express = require("express");
const router = express.Router();

/**
 * Route to add recurring budget periods for a given user. Takes in the budget period type and startDate
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    let { type, startDate } = req.body;
    type = type.toLowerCase();
    const user_id = req.user.id;
    console.log(user_id);
    startDate = dayjs(startDate);
    console.log(startDate);

    //Add budget periods based on period type
    if (type === "monthly") {
      await addBudgetPeriods(startDate, type, user_id, 1, "month");
    } else if (type === "weekly") {
      await addBudgetPeriods(startDate, type, user_id, 1, "week");
    } else if (type === "daily") {
      await addBudgetPeriods(startDate, type, user_id, 1, "day");
    } else if (type === "biweekly") {
      await addBudgetPeriods(startDate, type, user_id, 2, "week");
    } else if (type === "yearly") {
      await addBudgetPeriods(startDate, type, user_id, 1, "year");
    } else {
      return res.status(400).send({ error: "Invalid budget period type" });
    }

    //Retrieves the most current budget period
    let currentBudgetPeriod = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, startDate]
    );
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    return res.status(200).send({ currentBudgetPeriod });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to create budget periods" });
  }
});

/**
 * Route to update the budget period type. This entails changing all the following budget periods to the given type or adding new ones if there are no more budget periods
 */
router.put("/", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { startDate, type, currentBudgetPeriodId } = req.body;
    type = type.toLowerCase();
    console.log("REQBODY", startDate, type, currentBudgetPeriodId);
    startDate = dayjs(startDate);
    let today = dayjs();
    const unitsOfTime = { daily: "day", monthly: "month", biweekly: "week", weekly: "week", yearly: "year" };
    const numUnits = { daily: 1, monthly: 1, biweekly: 2, weekly: 1, yearly: 1 };

    let currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriodId]);
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    console.log(currentBudgetPeriod);
    //update the current budget_period
    //if the start date of the new budget periods is equal or after the start of the current budget period then set the end date of the current period to the start date
    //if before then update the current budget period to start at the startdate
    if (startDate <= currentBudgetPeriod.start_date) {
      let endDate = startDate.add(numUnits[type], unitsOfTime[type]);
      currentBudgetPeriod = await pool.query(
        "UPDATE budget_periods SET start_date = $1, end_date=$2, period_type=$3 WHERE id = $4 RETURNING *",
        [startDate, endDate, type, currentBudgetPeriodId]
      );
      startDate = endDate;
    } else {
      currentBudgetPeriod = await pool.query("UPDATE budget_periods SET end_date=$1 WHERE id = $2 RETURNING *", [
        startDate,
        currentBudgetPeriodId,
      ]);
    }
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    console.log("START_DATE", startDate);
    //delete the following budget periods so we can make new updated ones
    await pool.query("DELETE FROM budget_periods WHERE end_date > $1 AND user_id=$2", [startDate, user_id]);

    //Recalculate the total budget
    let user = await pool.query("SELECT income, savings FROM users WHERE id=$1", [user_id]);
    user = user.rows[0];
    console.log("USER", user);
    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;
    const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);
    console.log("TOTAL BUDGET", totalBudget);

    //then add the rest of the budget_periods
    if (type in unitsOfTime) {
      console.log(numUnits[type], unitsOfTime[type]);
      await addBudgetPeriods(startDate, type, user_id, numUnits[type], unitsOfTime[type], totalBudget);
    } else {
      return res.status(400).send({ error: "Invalid budget period type" });
    }

    //retrieve the goals to update them according to the budget periods
    let goals = await pool.query("SELECT * FROM goals WHERE user_id = $1", [user_id]);
    goals = goals.rows;
    console.log("GOALS", goals);

    goals.forEach(async (goal) => {
      let progress = await pool.query(
        `SELECT SUM(amount) FROM 
        (
          SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
        ) AS valid_budgets`,
        [goal.id, startDate]
      );
      progress = progress.rows[0].sum;
      console.log("PROGRESS", progress);
      //calculate the average amount to take out every budget period to achieve the goal
      let budgetPeriods = await pool.query(
        "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date <= $2 AND end_date > $3",
        [user_id, goal.end_date, startDate]
      );
      budgetPeriods = budgetPeriods.rows;
      let numBudgetPeriods = budgetPeriods.length;
      console.log("BUDGETPERIODS", budgetPeriods);
      console.log("NUMBUDGETPERIODS", numBudgetPeriods);
      const averageAmount = (goal.amount - progress) / numBudgetPeriods;
      console.log("AVERAGE", averageAmount);

      //then link the user goals with a user's budget periods until the goal is complete
      budgetPeriods.forEach(async (period) => {
        await pool.query("INSERT INTO budget_period_goals (amount, goal_id,budget_period_id ) VALUES ($1, $2, $3)", [
          averageAmount,
          goal.id,
          period.id,
        ]);
      });
    });

    //retrieve the goals and transactions linked to the current budget period
    let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

    let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND budget_period_id=$2", [
      user_id,
      currentBudgetPeriod.id,
    ]);

    transactions = transactions.rows;

    return res.status(200).send({ currentBudgetPeriod, currentGoals, transactions });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to update budget periods" });
  }
});

/**
 * Route to retrieve the most current budget period
 */
router.get("/current", requireAuth, async (req, res) => {
  try {
    const today = dayjs();

    const user_id = req.user.id;
    const result = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, today]
    );

    //IF WE CANT FIND A CURRENT BUDGET then add more budget periods using the information from the latest budget period
    if (result.rows.length === 0) {
      let latestBudgetPeriod = await pool.query(
        "SELECT * FROM budget_periods WHERE user_id = $1 AND start_date <= $2 ORDER BY end_date DESC LIMIT 1",
        [user_id, today]
      );

      if (latestBudgetPeriod.rows.length === 1) {
        let { period_type, end_date } = latestBudgetPeriod.rows[0];
        //convert the end date to a dayjs date object so we can manipulate it
        end_date = dayjs(end_date);
        if (period_type === "monthly") {
          //we want to add a 12 monthly budget periods (year's worth)
          await addBudgetPeriods(end_date, period_type, user_id, 1, "month");
        } else if (period_type === "weekly") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "week");
        } else if (period_type === "daily") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "day");
        } else if (period_type === "biweekly") {
          await addBudgetPeriods(end_date, period_type, user_id, 2, "week");
        } else if (period_type === "yearly") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "year");
        }

        //since we created more budget periods we can then retrieve the current one
        const newCurrentBudget = await pool.query(
          "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
          [user_id, today]
        );
        console.log(newCurrentBudget.rows);
        return res.status(200).send({
          currentBudgetPeriod: newCurrentBudget.rows[0],
          currentGoals: [],
          transactions: [],
        });
      }
    }
    const currentBudgetPeriod = result.rows[0];

    if (currentBudgetPeriod) {
      let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
        currentBudgetPeriod.id,
      ]);

      let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND budget_period_id=$2", [
        user_id,
        currentBudgetPeriod.id,
      ]);

      return res.status(200).send({
        currentBudgetPeriod,
        currentGoals: currentGoals.rows,
        transactions: transactions.rows,
      });
    } else {
      return res.status(400).send({ error: "No current budget" });
    }
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

const getTotalBudget = (income, fixedSpending, savings) => {
  return income - fixedSpending - (income - fixedSpending) * (savings / 100);
};

/**
 *Adds recurring budget periods for the length of a year
 * @param {*} initialDate date to start adding budget periods
 * @param {*} type budget period type
 * @param {*} user_id
 * @param {*} amount number of time units to add. For ex. biweekly is 2 (amount) weeks
 * @param {*} unit unit of time. For ex. Month
 * @param {*} total_budget the initial total budget of the period type
 * @returns a promise to indicate if budget periods were added successfully
 */
const addBudgetPeriods = async (initialDate, type, user_id, amount, unit, total_budget = 0) => {
  try {
    let start_date = initialDate;
    let end_date = start_date.add(amount, unit);
    let final_date = dayjs(initialDate).add(1, "year");

    while (end_date <= final_date) {
      await pool.query(
        "INSERT INTO budget_periods (period_type, start_date, end_date, user_id, total_budget) VALUES ($1, $2, $3, $4, $5)",
        [type, start_date, end_date, user_id, total_budget]
      );
      start_date = end_date;
      end_date = start_date.add(amount, unit);
    }

    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};

module.exports = router;
