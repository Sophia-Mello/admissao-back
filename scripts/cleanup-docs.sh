#!/bin/bash
#
# cleanup-docs.sh - Higienização da documentação
#
# Uso: ./scripts/cleanup-docs.sh [--dry-run]
#

set +e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DOCS_DIR="$REPO_ROOT/docs"

DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo -e "${YELLOW}=== MODO DRY-RUN ===${NC}\n"
fi

DELETED=0
ARCHIVED=0
CREATED=0

log() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
info() { echo -e "${CYAN}→${NC} $1"; }

delete_file() {
    local file="$1"
    local reason="$2"
    if [[ -f "$DOCS_DIR/$file" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            info "[DRY-RUN] Deletaria: $file ($reason)"
        else
            rm "$DOCS_DIR/$file"
            log "Deletado: $file ($reason)"
        fi
        ((DELETED++))
    else
        warn "Não encontrado: $file"
    fi
}

archive_file() {
    local file="$1"
    local dest="$2"
    if [[ -f "$DOCS_DIR/$file" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            info "[DRY-RUN] Arquivaria: $file → $dest"
        else
            mkdir -p "$DOCS_DIR/$(dirname "$dest")"
            mv "$DOCS_DIR/$file" "$DOCS_DIR/$dest"
            log "Arquivado: $file → $dest"
        fi
        ((ARCHIVED++))
    else
        warn "Não encontrado: $file"
    fi
}

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║           HIGIENIZAÇÃO DA DOCUMENTAÇÃO                       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}\n"

cd "$DOCS_DIR"

# ============================================================================
# FASE 1: DELETAR DUPLICADOS
# ============================================================================
echo -e "${RED}═══ FASE 1: Deletando duplicados ═══${NC}\n"

delete_file "RS_ADMISSAO_SCHEMA.md" "Duplicado de DATA_MODEL.md"
delete_file "ROTAS-FINAIS-BOOKING-SYSTEM.md" "Duplicado de api/FRONTEND_BACKEND_API_CONTRACTS.md"
delete_file "DEPLOY_SCRIPTS_README.md" "Conteúdo em CLAUDE.md"
delete_file "validation-reports/OLD-ROUTES-CLEANUP.md" "Duplicado do plano de refactoring"
delete_file "validation-reports/MIGRATION-CODE-CHANGES.md" "Duplicado do plano de refactoring"

# ============================================================================
# FASE 2: ARQUIVAR HISTÓRICO
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 2: Arquivando documentos históricos ═══${NC}\n"

# Criar diretório de validação histórica
if [[ "$DRY_RUN" == false ]]; then
    mkdir -p "$DOCS_DIR/archive/validation-2025-11"
fi

archive_file "FUTURE_IDEAS.md" "archive/FUTURE_IDEAS.md"
archive_file "validation-reports/MASTER-SUMMARY.md" "archive/validation-2025-11/MASTER-SUMMARY.md"
archive_file "validation-reports/IDEAL-CONTRACTS-STATUS.md" "archive/validation-2025-11/IDEAL-CONTRACTS-STATUS.md"
archive_file "validation-reports/public-bookings-part1.md" "archive/validation-2025-11/public-bookings-part1.md"
archive_file "validation-reports/public-bookings-part2.md" "archive/validation-2025-11/public-bookings-part2.md"

# ============================================================================
# FASE 3: CONSOLIDAR BOOKING_FLOW
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 3: Consolidando documentação de fluxo ═══${NC}\n"

if [[ -f "$DOCS_DIR/BOOKING_FLOW.md" ]] && [[ -f "$DOCS_DIR/NEW_BOOKING_FLOW_UX.md" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Arquivaria NEW_BOOKING_FLOW_UX.md (BOOKING_FLOW.md é mais completo)"
    else
        mv "$DOCS_DIR/NEW_BOOKING_FLOW_UX.md" "$DOCS_DIR/archive/NEW_BOOKING_FLOW_UX.md"
        log "Arquivado: NEW_BOOKING_FLOW_UX.md (mantendo BOOKING_FLOW.md como fonte única)"
    fi
    ((ARCHIVED++))
else
    warn "Arquivos de fluxo não encontrados para consolidação"
fi

# ============================================================================
# FASE 4: LIMPAR DIRETÓRIOS VAZIOS
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 4: Limpando diretórios vazios ═══${NC}\n"

if [[ "$DRY_RUN" == false ]]; then
    # Remove validation-reports se estiver vazio
    if [[ -d "$DOCS_DIR/validation-reports" ]] && [[ -z "$(ls -A "$DOCS_DIR/validation-reports")" ]]; then
        rmdir "$DOCS_DIR/validation-reports"
        log "Removido diretório vazio: validation-reports/"
    fi
else
    if [[ -d "$DOCS_DIR/validation-reports" ]]; then
        info "[DRY-RUN] Removeria diretório vazio: validation-reports/"
    fi
fi

# ============================================================================
# FASE 5: ARQUIVAR PLANOS ANTIGOS
# ============================================================================
echo -e "\n${YELLOW}═══ FASE 5: Organizando planos ═══${NC}\n"

# Os planos têm valor histórico - manter em plans/ mas renomear para clareza
if [[ -f "$DOCS_DIR/plans/2024-12-01-route-refactoring-design.md" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Manteria: plans/2024-12-01-route-refactoring-design.md (plano de refatoração)"
    else
        log "Mantido: plans/2024-12-01-route-refactoring-design.md"
    fi
fi

if [[ -f "$DOCS_DIR/plans/2025-12-01-test-suite-implementation.md" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Manteria: plans/2025-12-01-test-suite-implementation.md (plano de testes)"
    else
        log "Mantido: plans/2025-12-01-test-suite-implementation.md"
    fi
fi

# ============================================================================
# RESUMO
# ============================================================================
echo -e "\n${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}                        RESUMO                                 ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}\n"

if [[ "$DRY_RUN" == true ]]; then
    echo -e "  ${YELLOW}Modo DRY-RUN - nenhuma alteração foi feita${NC}\n"
fi

echo -e "  Arquivos deletados:  ${GREEN}$DELETED${NC}"
echo -e "  Arquivos arquivados: ${GREEN}$ARCHIVED${NC}"

echo -e "\n${CYAN}═══════════════════════════════════════════════════════════════${NC}"

# ============================================================================
# ESTRUTURA FINAL
# ============================================================================
echo -e "\n${GREEN}Estrutura final de docs/:${NC}\n"

if [[ "$DRY_RUN" == false ]]; then
    find "$DOCS_DIR" -type f -name "*.md" | sed "s|$DOCS_DIR/||" | sort | while read -r f; do
        echo "  $f"
    done
else
    echo "  (execute sem --dry-run para ver estrutura final)"
fi

echo ""
