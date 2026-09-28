# ==============================================================================
# FHIP Pooled Estimates: Export Pipeline to Standalone Web App
# Converts R batch results in Output/ into data packages for the Web App in data/
# ==============================================================================

suppressPackageStartupMessages({
  library(tidyverse)
  library(jsonlite)
})

cat("Reading consolidated modelling outputs from Output/...\n")

summary_file <- "Output/all_stations_summary.csv"
flows_file   <- "Output/all_design_flows.csv"
pg_file      <- "Output/all_pooling_groups.csv"
zd_file      <- "Output/all_zdists.csv"

if (!file.exists(summary_file) || !file.exists(flows_file)) {
  stop("Consolidated output files not found in Output/. Run scripts/main.R first.")
}

# 1. Stations summary with classifications
stations <- read.csv(summary_file, stringsAsFactors = FALSE) %>%
  dplyr::mutate(
    station_id = as.character(station_id),
    region_group = dplyr::case_when(
      measuring_authority_id == "NRW" ~ "NRW (Wales)",
      grepl("EA-", measuring_authority_id) ~ "EA (England)",
      grepl("SEPA", measuring_authority_id) ~ "SEPA (Scotland)",
      grepl("DFI", measuring_authority_id, ignore.case = TRUE) ~ "DFI (Northern Ireland)",
      TRUE ~ "Other"
    ),
    display_label = paste0(station_id, " - ", station_name, " (", river, ")")
  ) %>%
  dplyr::arrange(station_id)

# 2. Design flows
flows <- read.csv(flows_file, stringsAsFactors = FALSE) %>%
  dplyr::mutate(station_id = as.character(station_id))

# 3. Pooling group donors (with SDM)
pg <- if (file.exists(pg_file)) {
  read.csv(pg_file, stringsAsFactors = FALSE) %>%
    dplyr::mutate(
      subject_station_id = as.character(subject_station_id),
      donor_station_id   = as.character(donor_station_id)
    )
} else {
  data.frame()
}

# 4. Z-Distances
zd <- if (file.exists(zd_file)) {
  read.csv(zd_file, stringsAsFactors = FALSE) %>%
    dplyr::mutate(station_id = as.character(station_id))
} else {
  data.frame()
}

webapp_payload <- list(
  stations       = stations,
  design_flows   = flows,
  pooling_groups = pg,
  zdists         = zd
)

data_dir <- "data"
dir.create(data_dir, recursive = TRUE, showWarnings = FALSE)

cat("Serializing data to JSON and JavaScript bundle in data/...\n")
json_output <- jsonlite::toJSON(webapp_payload, dataframe = "rows", auto_unbox = TRUE, digits = 6)

# 1. Write data/stations_data.json
writeLines(json_output, file.path(data_dir, "stations_data.json"))

# 2. Write data/stations_data.js (embedded global variable for zero-CORS compatibility)
writeLines(paste0("window.FHIP_DATA = ", json_output, ";"), file.path(data_dir, "stations_data.js"))

# 3. Synchronize raw CSVs
csv_dir <- file.path(data_dir, "csv")
dir.create(csv_dir, recursive = TRUE, showWarnings = FALSE)
file.copy(summary_file, file.path(csv_dir, "all_stations_summary.csv"), overwrite = TRUE)
file.copy(flows_file,   file.path(csv_dir, "all_design_flows.csv"),   overwrite = TRUE)
if (file.exists(pg_file)) file.copy(pg_file, file.path(csv_dir, "all_pooling_groups.csv"), overwrite = TRUE)
if (file.exists(zd_file)) file.copy(zd_file, file.path(csv_dir, "all_zdists.csv"), overwrite = TRUE)

cat("Successfully exported data to data/!\n")
cat(sprintf(" - %d stations\n", nrow(stations)))
cat(sprintf(" - %d design flows\n", nrow(flows)))
cat(sprintf(" - %d pooling donors\n", nrow(pg)))
cat(sprintf(" - %d z-dist diagnostic records\n", nrow(zd)))
