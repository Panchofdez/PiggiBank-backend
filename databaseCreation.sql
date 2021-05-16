

CREATE TABLE users (
	id SERIAL PRIMARY KEY,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
	username VARCHAR(50),
	email VARCHAR(100) NOT NULL UNIQUE,
	password VARCHAR(200),
	income NUMERIC DEFAULT 0,
	savings INTEGER DEFAULT 0 CHECK(savings >= 0 AND savings <= 100)
)


CREATE TABLE budget_periods (
	id SERIAL PRIMARY KEY,
	period_type VARCHAR(100),
	start_date TIMESTAMP WITH TIME ZONE NOT NULL,
	end_date TIMESTAMP WITH TIME ZONE NOT NULL,
	total_budget NUMERIC NOT NULL DEFAULT 0,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE fixed_expenses (
	id SERIAL PRIMARY KEY,
	title VARCHAR(100) NOT NULL,
	amount NUMERIC NOT NULL,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);



CREATE TABLE transactions (
	id SERIAL PRIMARY KEY,
	transaction_type VARCHAR(100) NOT NULL, 
	note VARCHAR(300) DEFAULT '',
	date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
	category VARCHAR(200) NOT NULL,
	amount NUMERIC NOT NULL CHECK(amount >= 0), 
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	budget_period_id INTEGER NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE
);



CREATE TABLE goals (
	id SERIAL PRIMARY KEY,
	colour VARCHAR(100),
	icon VARCHAR(100),
	title VARCHAR(100),
	amount NUMERIC NOT NULL DEFAULT 0,
	duration VARCHAR(100),
	end_date TIMESTAMP WITH TIME ZONE NOT NULL,
	progress NUMERIC DEFAULT 0,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE

);



CREATE TABLE budget_period_goals (
	id SERIAL PRIMARY KEY,
	amount NUMERIC NOT NULL CHECK(amount > 0), 
	goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
	budget_period_id INTEGER NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE
)
