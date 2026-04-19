#!/bin/bash
#
# cleanup-repo.sh - Script de higienização do repositório v0-backend-rs-admissao
#
# Este script remove arquivos desnecessários identificados na auditoria.
# SEMPRE cria backup antes de qualquer remoção.
#
# Uso: ./scripts/cleanup-repo.sh [--dry-run]
#
# Opções:
#   --dry-run   Mostra o que seria feito sem executar
#

# Não falhar em erros (arquivos podem não existir)
set +e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Diretório do script e do repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$REPO_ROOT/.cleanup-backup-$(date +%Y%m%d-%H%M%S)"

# Flag de dry-run
DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo -e "${YELLOW}=== MODO DRY-RUN: Nenhuma alteração será feita ===${NC}\n"
fi

# Contadores
REMOVED=0
MOVED=0
SKIPPED=0

# Função para log
log() {
    echo -e "${GREEN}✓${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
}

info() {
    echo -e "${CYAN}→${NC} $1"
}

# Função para remover arquivo com backup
remove_file() {
    local file="$1"
    local reason="$2"

    if [[ -f "$REPO_ROOT/$file" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            info "[DRY-RUN] Removeria: $file ($reason)"
        else
            mkdir -p "$BACKUP_DIR/$(dirname "$file")"
            cp "$REPO_ROOT/$file" "$BACKUP_DIR/$file"
            rm "$REPO_ROOT/$file"
            log "Removido: $file ($reason)"
        fi
        ((REMOVED++))
    else
        warn "Não encontrado (já removido?): $file"
        ((SKIPPED++))
    fi
}

# Função para mover arquivo
move_file() {
    local src="$1"
    local dest="$2"
    local reason="$3"

    if [[ -f "$REPO_ROOT/$src" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            info "[DRY-RUN] Moveria: $src → $dest ($reason)"
        else
            mkdir -p "$REPO_ROOT/$(dirname "$dest")"
            mv "$REPO_ROOT/$src" "$REPO_ROOT/$dest"
            log "Movido: $src → $dest ($reason)"
        fi
        ((MOVED++))
    else
        warn "Não encontrado: $src"
        ((SKIPPED++))
    fi
}

# Início
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     HIGIENIZAÇÃO DO REPOSITÓRIO v0-backend-rs-admissao       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

cd "$REPO_ROOT"

if [[ "$DRY_RUN" == false ]]; then
    echo -e "Criando diretório de backup: ${CYAN}$BACKUP_DIR${NC}\n"
    mkdir -p "$BACKUP_DIR"
fi

# ============================================================================
# FASE 1: CREDENCIAIS E SEGURANÇA (CRÍTICO)
# ============================================================================
echo -e "\n${RED}═══ FASE 1: Removendo credenciais expostas (CRÍTICO) ═══${NC}\n"

remove_file ".env" "Credenciais reais expostas"
remove_file "LightsailDefaultKey-us-east-2.pem" "Chave SSH privada"
remove_file "..env.swp" "Arquivo swap do Vim com credenciais"

# ============================================================================
# FASE 2: LIXO EVIDENTE
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 2: Removendo lixo evidente ═══${NC}\n"

# Lock files
remove_file ".~lock.Cópia de Matriz Vagas_2026 - Página29.csv#" "Lock file do LibreOffice"

# Código duplicado
remove_file "src/services/gupyService-working.js" "Código duplicado não utilizado"

# OpenAPI desatualizado
remove_file "openapi_subset.yaml" "Subset desatualizado do openapi.yaml"

# Documentação com hash no nome
remove_file "DEPLOY_CHECKLIST_bc75a16.md" "Checklist desatualizado com hash"

# ============================================================================
# FASE 3: ARQUIVOS DE DADOS
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 3: Removendo arquivos de dados soltos ═══${NC}\n"

remove_file "Cópia de Matriz Vagas_2026 - Página29.csv" "Dados devem estar no banco/storage"
remove_file "endereco - subregionais.csv" "Dados devem estar no banco/storage"

# ============================================================================
# FASE 4: SCRIPTS DE DEPLOY LEGADO
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 4: Removendo scripts de deploy legado ═══${NC}\n"

remove_file "deploy-and-monitor.sh" "Substituído por GitHub Actions"
remove_file "deploy-clean.sh" "Substituído por GitHub Actions"
remove_file "remote-deploy.sh" "Substituído por GitHub Actions"

# ============================================================================
# FASE 5: DOCUMENTAÇÃO DESORGANIZADA
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 5: Organizando documentação ═══${NC}\n"

# Mover docs da raiz para docs/
if [[ -f "$REPO_ROOT/API_CONTRACTS_IDEAL.md" ]]; then
    move_file "API_CONTRACTS_IDEAL.md" "docs/archive/API_CONTRACTS_IDEAL.md" "Organização"
fi

if [[ -f "$REPO_ROOT/FRONTEND_BACKEND_API_CONTRACTS.md" ]]; then
    move_file "FRONTEND_BACKEND_API_CONTRACTS.md" "docs/api/FRONTEND_BACKEND_API_CONTRACTS.md" "Organização"
fi

# ============================================================================
# FASE 6: MIGRATIONS PROBLEMÁTICAS
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 6: Corrigindo migrations ═══${NC}\n"

# Remover migration duplicada
remove_file "migrations/0012_add_id_job_gupy_to_get_slots.sql" "Duplicada pela 0050"

# Renumerar 0009 conflitante (criar cópia com novo número)
if [[ -f "$REPO_ROOT/migrations/0009_create_get_slots_function_prod.sql" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Renumeraria: 0009_create_get_slots_function_prod.sql → 0010_create_get_slots_function_prod.sql"
    else
        cp "$REPO_ROOT/migrations/0009_create_get_slots_function_prod.sql" \
           "$REPO_ROOT/migrations/0010_create_get_slots_function_prod.sql"
        rm "$REPO_ROOT/migrations/0009_create_get_slots_function_prod.sql"
        log "Renumerado: 0009_create_get_slots_function_prod.sql → 0010_create_get_slots_function_prod.sql"
    fi
fi

# ============================================================================
# FASE 7: TESTES TEMPORÁRIOS (opcional, comentado por segurança)
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 7: Testes temporários (mantidos por precaução) ═══${NC}\n"

warn "Arquivos de teste mantidos (revisar manualmente se necessário):"
echo "  - tests/test-concurrent-bookings.js"
echo "  - tests/test-advisory-lock.js"
echo "  - tests/test-constraint-exists.js"

# ============================================================================
# RESUMO
# ============================================================================
echo -e "\n${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}                        RESUMO                                 ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}Modo DRY-RUN - nenhuma alteração foi feita${NC}\n"
fi

echo -e "  Arquivos removidos: ${GREEN}$REMOVED${NC}"
echo -e "  Arquivos movidos:   ${GREEN}$MOVED${NC}"
echo -e "  Arquivos ignorados: ${YELLOW}$SKIPPED${NC}"

if [[ "$DRY_RUN" == false ]] && [[ -d "$BACKUP_DIR" ]]; then
    echo -e "\n  Backup salvo em: ${CYAN}$BACKUP_DIR${NC}"
fi

echo -e "\n${CYAN}═══════════════════════════════════════════════════════════════${NC}"

# ============================================================================
# PRÓXIMOS PASSOS
# ============================================================================
echo -e "\n${GREEN}Próximos passos:${NC}\n"
echo "  1. Verificar se o .env.example está correto e completo"
echo "  2. git add -A && git status (revisar alterações)"
echo "  3. git commit -m 'chore: repository cleanup - remove unused files'"
echo "  4. IMPORTANTE: Limpar histórico do git (credenciais ainda estão lá):"
echo ""
echo "     # Instalar BFG Repo Cleaner (mais seguro que filter-branch)"
echo "     # https://rtyley.github.io/bfg-repo-cleaner/"
echo ""
echo "     bfg --delete-files '.env' --delete-files '*.pem' ."
echo "     git reflog expire --expire=now --all"
echo "     git gc --prune=now --aggressive"
echo "     git push --force"
echo ""
echo "  5. Rotacionar TODAS as credenciais expostas:"
echo "     - JWT_SECRET"
echo "     - GUPY_API_KEY"
echo "     - Google Service Account"
echo "     - Criar nova SSH key no Lightsail"
echo ""
