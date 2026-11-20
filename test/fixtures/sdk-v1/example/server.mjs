// Deliberate trap: discovery must never evaluate this fixture.
globalThis.__sdkFixtureServerExecuted = true;
throw new Error('El fixture de catálogo no debe ejecutarse');
