.PHONY: install test seed serve web

install:
	python3 -m venv .venv
	.venv/bin/pip install -e ".[dev]"
	cd web && npm install

test:
	.venv/bin/pytest -q

seed:
	.venv/bin/l0 seed

serve:
	.venv/bin/l0 serve --host 127.0.0.1 --port 8000

web:
	cd web && npm run dev

pages:
	bash scripts/publish-pages.sh
