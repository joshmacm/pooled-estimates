# ==============================================================================
# FHIP UKFE Modelling: Automated Batch Pooled Flood Frequency Analysis
# Natural Resources Wales - Hydrology & Water Resources Management
# ==============================================================================

suppressPackageStartupMessages({
  library(UKFE)
  library(tidyverse)
  library(future.apply)
  library(parallelly)
  library(pbapply)
})

# Source modular calculation function
source("R/station_calculation.R")

# ------------------------------------------------------------------------------
# 1. Calculation & Execution Parameters
# ------------------------------------------------------------------------------
urbext_threshold    <- 0.03   # URBEXT threshold for urban adjustment & pooling logic
number_years        <- 800    # Target minimum station-years for pooling group
de_urbanise         <- TRUE   # De-urbanise donor pooling group records
excluded_sites      <- c()    # Stations explicitly excluded from pooling groups
non_flood_years_pct <- 15     # AMAX non-flood year adjustment threshold (%)

export_individual   <- TRUE   # Export individual per-station CSVs
output_dir_indiv    <- "Output/Individual Results"
output_dir_consol   <- "Output"

# Create output directories if needed
dir.create(output_dir_indiv, recursive = TRUE, showWarnings = FALSE)
dir.create(output_dir_consol, recursive = TRUE, showWarnings = FALSE)
dir.create("data", recursive = TRUE, showWarnings = FALSE)

# ------------------------------------------------------------------------------
# 2. Data Ingestion: Peak Flow Datasets & Station Catalogue
# ------------------------------------------------------------------------------
cat("Loading Peak Flow Dataset from UKFE and metadata catalogue...\n")

# Load UKFE package datasets
data("PeakFlowData", package = "UKFE", envir = .GlobalEnv)
data("AMPF", package = "UKFE", envir = .GlobalEnv)

# Load station catalogue metadata
catalogue_file <- "data/nrfa_station_info.csv"
if (!file.exists(catalogue_file) && file.exists("nrfa_station_info.csv")) {
  catalogue_file <- "nrfa_station_info.csv"
}

if (file.exists(catalogue_file)) {
  cat(sprintf("Reading station catalogue from %s...\n", catalogue_file))
  station_info_raw <- read.csv(catalogue_file, stringsAsFactors = FALSE)
} else {
  cat("Downloading latest NRFA station catalogue via rnrfa...\n")
  station_info_raw <- rnrfa::catalogue()
  station_info_raw <- station_info_raw[!vapply(station_info_raw, is.data.frame, logical(1))]
  write.csv(station_info_raw, "data/nrfa_station_info.csv", row.names = FALSE)
}

# Standardize catalogue column names
names(station_info_raw) <- gsub("[.-]", "_", names(station_info_raw))
station_meta <- station_info_raw %>%
  dplyr::mutate(station_id = as.character(id)) %>%
  dplyr::select(
    station_id,
    station_name = name,
    river,
    catchment_area,
    latitude,
    longitude,
    easting,
    northing,
    dplyr::any_of(c("measuring_authority_id", "station_type"))
  )

# ------------------------------------------------------------------------------
# 3. Identify Target Pooling Stations
# ------------------------------------------------------------------------------
stations <- row.names(PeakFlowData %>% dplyr::filter(Suitability == "Pooling"))
total_stations <- length(stations)
cat(sprintf("Identified %d stations flagged as suitable for pooling.\n", total_stations))

# ------------------------------------------------------------------------------
# 4. Batch Parallel Execution
# ------------------------------------------------------------------------------
num_workers <- max(1, parallelly::availableCores() - 1)
cat(sprintf("Configuring parallel execution plan with %d workers...\n", num_workers))

if (parallelly::supportsMulticore()) {
  future::plan(future::multicore, workers = num_workers)
} else {
  future::plan(future::multisession, workers = num_workers)
}

cat("Starting pooled flood frequency calculations...\n")
start_time <- Sys.time()

res_list <- future.apply::future_lapply(
  stations,
  function(stn_id) {
    station_calculation(
      id = stn_id,
      urbext_threshold = urbext_threshold,
      number_years = number_years,
      de_urbanise = de_urbanise,
      excluded_sites = excluded_sites,
      non_flood_years_pct = non_flood_years_pct,
      export_individual = export_individual,
      output_dir = output_dir_indiv
    )
  },
  future.seed = TRUE
)

# Return to sequential evaluation
future::plan(future::sequential)

elapsed <- round(difftime(Sys.time(), start_time, units = "mins"), 2)
cat(sprintf("Calculations completed in %s minutes.\n", elapsed))

# ------------------------------------------------------------------------------
# 5. Execution Logging & Diagnostics
# ------------------------------------------------------------------------------
run_log <- purrr::map_dfr(res_list, function(x) {
  tibble::tibble(
    station_id = x$station_id,
    success = isTRUE(x$success),
    error_message = if (isTRUE(x$success)) NA_character_ else x$error_message,
    timestamp = Sys.time()
  )
})

readr::write_csv(run_log, file.path(output_dir_consol, "run_log.csv"))
success_count <- sum(run_log$success)
cat(sprintf("Successful: %d / %d (Failed: %d)\n", success_count, total_stations, total_stations - success_count))

success_runs <- purrr::keep(res_list, ~ isTRUE(.x$success))

# ------------------------------------------------------------------------------
# 6. Build Dashboard-Friendly Consolidated Outputs
# ------------------------------------------------------------------------------
cat("Assembling consolidated dashboard datasets...\n")

if (length(success_runs) > 0) {
  
  # A. Long Design Flows Table (ideal for plotting curves & return period filtering)
  all_design_flows <- purrr::map_dfr(success_runs, "design_flows") %>%
    dplyr::left_join(station_meta, by = "station_id")
  
  file_flows <- file.path(output_dir_consol, "all_design_flows.csv")
  readr::write_csv(all_design_flows, file_flows)
  cat(sprintf("  Saved: %s (%d rows)\n", file_flows, nrow(all_design_flows)))
  
  # B. Wide Station Summary Table (ideal for maps, KPI tables & GIS popups)
  flows_wide_Q <- all_design_flows %>%
    dplyr::select(station_id, RP, Q) %>%
    dplyr::mutate(RP = paste0("Q_", RP)) %>%
    tidyr::pivot_wider(names_from = RP, values_from = Q)
  
  flows_100_ci <- all_design_flows %>%
    dplyr::filter(RP == 100) %>%
    dplyr::select(station_id, Q100_Lower95 = Lower95, Q100_Upper95 = Upper95)
  
  station_stats <- purrr::map_dfr(success_runs, function(x) {
    zd <- x$zdists
    tibble::tibble(
      station_id = x$station_id,
      QMED_observed = round(x$qmed_observed, 3),
      UAF = round(x$UAF, 4),
      QMED_rural = round(x$qmed_rural, 3),
      URBEXT2015 = round(x$station_urbext, 5),
      chosen_distribution = x$distribution,
      z_GLO = if (!is.null(zd) && "GenLog" %in% names(zd)) round(as.numeric(zd[["GenLog"]]), 3) else NA_real_,
      z_GEV = if (!is.null(zd) && "GEV" %in% names(zd)) round(as.numeric(zd[["GEV"]]), 3) else NA_real_,
      z_PT3 = if (!is.null(zd) && "Pearson3" %in% names(zd)) round(as.numeric(zd[["Pearson3"]]), 3) else NA_real_,
      n_donors = if (!is.null(x$pooling_group)) nrow(x$pooling_group) else NA_integer_,
      total_donor_years = if (!is.null(x$pooling_group) && "N" %in% names(x$pooling_group)) {
        sum(x$pooling_group$N, na.rm = TRUE)
      } else NA_real_
    )
  })
  
  all_stations_summary <- station_meta %>%
    dplyr::inner_join(station_stats, by = "station_id") %>%
    dplyr::left_join(flows_wide_Q, by = "station_id") %>%
    dplyr::left_join(flows_100_ci, by = "station_id")
  
  file_summary <- file.path(output_dir_consol, "all_stations_summary.csv")
  readr::write_csv(all_stations_summary, file_summary)
  cat(sprintf("  Saved: %s (%d stations)\n", file_summary, nrow(all_stations_summary)))
  
  # C. Consolidated Pooling Groups Table
  all_pooling_groups <- purrr::map_dfr(success_runs, "pooling_group")
  file_pg <- file.path(output_dir_consol, "all_pooling_groups.csv")
  readr::write_csv(all_pooling_groups, file_pg)
  cat(sprintf("  Saved: %s (%d donor mappings)\n", file_pg, nrow(all_pooling_groups)))
  
  # D. Consolidated Z-Distances
  all_zdists <- purrr::map_dfr(success_runs, function(x) {
    if (!is.null(x$zdists)) {
      df <- as.data.frame(as.list(x$zdists))
      df$station_id <- x$station_id
      df
    } else {
      NULL
    }
  })
  if (nrow(all_zdists) > 0) {
    file_zd <- file.path(output_dir_consol, "all_zdists.csv")
    readr::write_csv(all_zdists, file_zd)
    cat(sprintf("  Saved: %s (%d stations)\n", file_zd, nrow(all_zdists)))
  }

  # E. Complete R Object (full fidelity for downstream R workflows)
  file_rds <- file.path(output_dir_consol, "all_results.rds")
  saveRDS(res_list, file_rds)
  cat(sprintf("  Saved: %s\n", file_rds))
}

# 6. Auto-export to Standalone Web App
if (file.exists("scripts/export_webapp.R")) {
  cat("\nExporting fresh data packages for the Web App viewer...\n")
  source("scripts/export_webapp.R")
}

cat("\nPipeline and web app data update finished successfully!\n")
