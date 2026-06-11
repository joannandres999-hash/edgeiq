# EDGEIQ World Cup Scheduler

Corre automáticamente cada 10 minutos en GitHub Actions.
PC apagado = no importa, GitHub lo corre igual.

## Qué hace
1. Detecta partidos en vivo del Mundial 2026
2. Busca stats en tiempo real (Perplexity Sonar)
3. Guarda en Supabase cada 10 minutos
4. Acumula perfil por equipo partido a partido

## Secrets requeridos en GitHub
- SUPABASE_URL
- SUPABASE_SECRET_KEY
- OPENROUTER_KEY
