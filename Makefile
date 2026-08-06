.PHONY: test test-backend test-frontend build up down

test-backend:
	docker compose --profile test run --rm backend-v2-test

test-frontend:
	cd frontend-v2 && npm test

test: test-backend test-frontend

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down
