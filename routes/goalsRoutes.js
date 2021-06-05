const pool = require("../db");
const dayjs = require("dayjs");
const requireAuth = require("../middleware/requireAuth");
const express = require("express");
const router = express.Router();

/**
 * Retrieves the average amount to take out of each budget period to achieve the goal.
 * It takes in the goal amount which is the money it takes to reach the goal,
 * and it takes the numUnits and unitOfTime which is used to calculate how long we have to achieve the goal
 */
router.get("/averageamount", requireAuth, async (req, res) => {
  try {
    const { amount, numUnits, unitOfTime } = req.query;
    const user_id = req.user.id;
    console.log(amount, numUnits, unitOfTime);
    const today = dayjs();
    const endDate = today.add(numUnits, unitOfTime);

    console.log("ENDDATE", endDate);
    //calculate the average amount to take out every budget period to achieve the goal
    let budgetPeriods = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date <= $2 AND end_date > $3",
      [user_id, endDate, today]
    );
    budgetPeriods = budgetPeriods.rows;
    let numBudgetPeriods = budgetPeriods.length;
    console.log("BUDGETPERIODS", budgetPeriods);
    console.log("NUMBUDGETPERIODS", numBudgetPeriods);
    let averageAmount;
    if (numBudgetPeriods === 0) {
      averageAmount = amount;
    } else {
      averageAmount = amount / numBudgetPeriods;
    }
    console.log("AVERAGE", averageAmount);
    return res.status(200).send({ averageAmount, endDate });
  } catch (error) {
    console.log(error.message);
    res
      .status(400)
      .send({ error: "Unable to calculate average amount to take from budget period to achieve the goal" });
  }
});

/**
 * Creates a user goal and updates the necessary budget periods to take out the amount needed to achieve the goal.
 *
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const { title, amount, duration, averageAmount, endDate, colour, icon, currentBudgetPeriodId } = req.body;
    const today = dayjs();
    // const endDate = today.add(numUnits, unitOfTime);
    // console.log(endDate);
    const user_id = req.user.id;

    //create the goal in goals table
    let goal = await pool.query(
      "INSERT INTO goals (colour, icon, title, amount, duration, end_date, user_id) VALUES ($1,$2,$3,$4,$5,$6, $7) RETURNING *",
      [colour, icon, title, amount, duration, endDate, user_id]
    );
    goal = goal.rows[0];
    console.log("GOAL", goal);

    //calculate the average amount to take out every budget period to achieve the goal
    let budgetPeriods = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date <= $2 AND end_date > $3",
      [user_id, endDate, today]
    );
    budgetPeriods = budgetPeriods.rows;

    //then link the user goals with a user's budget periods until the goal is complete
    if (budgetPeriods.length === 0) {
      await pool.query("INSERT INTO budget_period_goals (amount, goal_id,budget_period_id ) VALUES ($1, $2, $3)", [
        averageAmount,
        goal.id,
        currentBudgetPeriodId,
      ]);
    } else {
      for (let i = 0; i < budgetPeriods.length; i++) {
        let period = budgetPeriods[i];
        await pool.query("INSERT INTO budget_period_goals (amount, goal_id,budget_period_id ) VALUES ($1, $2, $3)", [
          averageAmount,
          goal.id,
          period.id,
        ]);
      }
    }

    //retrieve the goals linked to the current budget period
    let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

    let goals = await pool.query("SELECT * FROM goals WHERE user_id=$1", [user_id]);
    goals = goals.rows;
    // console.log("GOALS", goals);

    //Calculates the progress of each goal and adds it to the goal object
    let updatedGoals = await Promise.all(
      goals.map(async (goal) => {
        console.log(goal);
        const progress = await pool.query(
          `SELECT SUM(amount) FROM 
          (
            SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
          ) AS valid_budgets`,
          [goal.id, today]
        );
        console.log(progress.rows[0].sum);
        return Promise.resolve({ ...goal, progress: progress.rows[0].sum });
      })
    );

    return res.status(200).send({ currentGoals, goals: updatedGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to add goals, please try again" });
  }
});

/**
 * Gets the achievements of the user
 */
router.get("/achievements", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const today = dayjs();
    let amountSaved = await pool.query(
      `SELECT SUM(savings) FROM
      ( 
      SELECT * FROM budget_periods JOIN users ON budget_periods.user_id = users.id WHERE user_id = $1 AND end_date <= $2
      ) AS  past_budgets`,
      [user_id, today]
    );
    //the amount of money saved by the user
    console.log(amountSaved.rows);
    amountSaved = parseInt(amountSaved.rows[0].sum);

    let goals = await pool.query("SELECT * FROM goals WHERE user_id=$1", [user_id]);
    goals = goals.rows;
    let completedGoals = 0;
    for (let i = 0; i < goals.length; i++) {
      let progress = await pool.query(
        `SELECT SUM(amount) FROM 
          (
            SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
          ) AS valid_budgets`,
        [goals[i].id, today]
      );
      progress = progress.rows[0].sum;
      if (progress >= goals[i].amount) {
        console.log(progress, goals[i].amount);
        completedGoals++;
      }
    }

    //To calculate the number of budget periods that a user has completed
    let numBudgetPeriods = await pool.query("SELECT COUNT(*) FROM budget_periods WHERE user_id=$1 AND end_date <= $2", [
      user_id,
      today,
    ]);
    numBudgetPeriods = parseInt(numBudgetPeriods.rows[0].count);

    //We need to calculate if the user ha been budgeting for at least a year
    let initialStartDate = await pool.query(
      "SELECT start_date FROM budget_periods WHERE user_id=$1 ORDER BY start_date ASC LIMIT 1",
      [user_id]
    );
    initialStartDate = initialStartDate.rows[0].start_date;

    let fullYear = dayjs(initialStartDate).add(1, "year");

    console.log(initialStartDate, fullYear);
    console.log(dayjs("May 23 2022") >= fullYear);

    console.log(amountSaved, completedGoals, numBudgetPeriods);

    //array containing the user achievements
    let achievements = [
      {
        title: "Save $100",
        completed: amountSaved >= 10,
      },
      {
        title: "Save $1000",
        completed: amountSaved >= 1000,
      },
      {
        title: "Save $5000",
        completed: amountSaved >= 5000,
      },
      {
        title: "Complete 1 Goal",
        completed: completedGoals >= 1,
      },
      {
        title: "Complete 5 Goals",
        completed: completedGoals >= 5,
      },
      {
        title: "Complete 10 Goals",
        completed: completedGoals >= 10,
      },
      {
        title: "Budget For 3 Periods",
        completed: numBudgetPeriods >= 3,
      },
      {
        title: "Budget For A Full Year",
        completed: today >= fullYear,
      },
      {
        title: "Save $10,000",
        completed: amountSaved >= 10000,
      },
    ];
    console.log(achievements);
    return res.status(200).send({ achievements });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve achievements" });
  }
});

/**
 * Get the goals that are affecting the current budget period
 */
router.get("/:currentBudgetPeriodId", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { currentBudgetPeriodId } = req.params;
    console.log(user_id, currentBudgetPeriodId);
    const today = dayjs();
    //get all the user goals
    let goals = await pool.query("SELECT * FROM goals WHERE user_id=$1", [user_id]);
    goals = goals.rows;
    console.log("GOALS", goals);
    //We only want the relevant goals that are part of the current budget period
    let currentGoals = await pool.query("SELECT goal_id FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

    //only get the goals that are taking money from the budget of the current budget period
    goals = goals.filter((goal) => {
      for (let i = 0; i < currentGoals.length; i++) {
        if (currentGoals[i].goal_id === goal.id) {
          return true;
        }
      }
      return false;
    });

    console.log("AFTER", goals);

    //calculate the progress of each goal
    let updatedGoals = await Promise.all(
      goals.map(async (goal) => {
        const progress = await pool.query(
          `SELECT SUM(amount) FROM 
          (
            SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
          ) AS valid_budgets`,
          [goal.id, today]
        );
        return Promise.resolve({ ...goal, progress: progress.rows[0].sum });
      })
    );

    console.log("UPDATED", updatedGoals);

    return res.status(200).send({ goals: updatedGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve your goals" });
  }
});

module.exports = router;
