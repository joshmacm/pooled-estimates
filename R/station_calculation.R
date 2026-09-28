#' Pooled Flood Frequency Analysis for a Single Station
#'
#' Implements Flood Estimation Handbook (FEH) statistical pooling analysis
#' incorporating Urban Adjustment Factors (UAF), Non-Flood Year (NFY) adjustments,
#' optimal distribution selection via Z-distance goodness-of-fit, and 
#' 95% confidence intervals based on Hammond (2021).
#'
#' @param id Gauging station ID (character or numeric).
#' @param urbext_threshold Urban extent threshold for pooling group creation (default: 0.03).
#' @param number_years Minimum station-years target for pooling group (default: 800).
#' @param de_urbanise Logical, whether to de-urbanise donor pooling group records (default: TRUE).
#' @param excluded_sites Vector of station IDs to exclude from pooling group (default: NULL).
#' @param non_flood_years_pct Percentage threshold of AMAX records to apply Non-Flood Year adjustment (default: 15).
#' @param export_individual Logical, whether to export individual CSVs for this station (default: TRUE).
#' @param output_dir Destination directory for individual station results (default: "Output/Individual Results").
#'
#' @return A list containing design flows, pooling group, NFY stats, index flows, and distribution diagnostics.
station_calculation <- function(
    id,
    urbext_threshold = 0.03,
    number_years = 800,
    de_urbanise = TRUE,
    excluded_sites = NULL,
    non_flood_years_pct = 15,
    export_individual = TRUE,
    output_dir = "Output/Individual Results"
) {
  
  station_id_str <- as.character(id)
  `%>%` <- dplyr::`%>%`
  
  tryCatch({
    # Ensure required UKFE datasets are available in global search path
    if (!exists("PeakFlowData", envir = .GlobalEnv)) {
      utils::data("PeakFlowData", package = "UKFE", envir = .GlobalEnv)
    }
    
    if (!exists("AMPF", envir = .GlobalEnv)) {
      utils::data("AMPF", package = "UKFE", envir = .GlobalEnv)
    }
    
    # 1. Retrieve Catchment Descriptors and observed gauged QMED
    Catchment_Descriptors <- UKFE::GetCDs(id)
    Gauge_QMED <- UKFE::GetQMED(id)
    
    if (is.null(Catchment_Descriptors) || nrow(Catchment_Descriptors) == 0) {
      stop(sprintf("No catchment descriptors found for station %s", station_id_str))
    }
    
    # 2. Calculate Urban Adjustment Factor (UAF) and rural QMED
    station_UAF <- UKFE::UAF(Catchment_Descriptors)
    rural_qmed <- Gauge_QMED / station_UAF
    
    # 3. Extract URBEXT2015 value
    Station_URBEXT_row <- Catchment_Descriptors %>%
      dplyr::filter(Descriptor == "URBEXT2015")
    
    if (nrow(Station_URBEXT_row) == 0) {
      Station_URBEXT <- 0
    } else {
      Station_URBEXT <- Station_URBEXT_row$Value[1]
    }
    
    # 4. Generate Pooling Group based on URBEXT threshold
    # Note: UKFE::Pool duplicates a station if supplied in 'include' while below UrbMax
    if (Station_URBEXT <= urbext_threshold) {
      Pooling_Group <- UKFE::Pool(
        CDs = Catchment_Descriptors,
        N = number_years,
        UrbMax = urbext_threshold,
        DeUrb = de_urbanise,
        exclude = excluded_sites
      )
    } else {
      Pooling_Group <- UKFE::Pool(
        CDs = Catchment_Descriptors,
        N = number_years,
        UrbMax = urbext_threshold,
        DeUrb = de_urbanise,
        exclude = excluded_sites,
        include = id
      )
    }
    
    # 5. Non-Flood Year (NFY) Adjustment
    NFY_Pooling_Group_Stats <- suppressWarnings(
      UKFE::NonFloodAdjPool(Pooling_Group, AutoP = non_flood_years_pct, ReturnStats = TRUE)
    )
    if (!is.null(NFY_Pooling_Group_Stats) && is.data.frame(NFY_Pooling_Group_Stats)) {
      NFY_Pooling_Group_Stats <- NFY_Pooling_Group_Stats %>% dplyr::select(-dplyr::any_of("N"))
    }
    
    Pooling_Group <- suppressWarnings(
      UKFE::NonFloodAdjPool(Pooling_Group, AutoP = non_flood_years_pct, ReturnStats = FALSE)
    )
    
    # 6. Goodness-of-Fit and Distribution Selection
    dists <- UKFE::Zdists(Pooling_Group)
    z_scores <- dists[[1]]
    abs_dists <- abs(z_scores)
    chosen_dist <- names(which.min(abs_dists))
    
    # 7. Pooled estimation with urban adjustment and gauged QMED
    Results <- UKFE::PoolEst(
      Pooling_Group,
      dist = chosen_dist,
      CDs = Catchment_Descriptors,
      QMEDEstimate = Gauge_QMED,
      Gauged = TRUE,
      UrbAdj = TRUE
    )
    
    # 8. Retrieve design flows & compute 95% Confidence Intervals (Hammond, 2021)
    Flows <- Results$Results %>%
      dplyr::mutate(
        station_id = station_id_str,
        Lower95 = round(Q / (FSE^1.96), 2),
        Upper95 = round(Q * (FSE^1.96), 2),
        chosen_distribution = chosen_dist,
        QMED_observed = round(Gauge_QMED, 3),
        UAF = round(station_UAF, 4),
        QMED_rural = round(rural_qmed, 3),
        URBEXT2015 = round(Station_URBEXT, 5)
      )
    
    # 9. Format Pooling Group export table
    Pooling_Group_Export <- Pooling_Group %>%
      tibble::rownames_to_column("donor_station_id") %>%
      dplyr::mutate(
        donor_station_id = as.character(donor_station_id),
        subject_station_id = station_id_str
      )
    
    if (!is.null(NFY_Pooling_Group_Stats) && nrow(NFY_Pooling_Group_Stats) > 0) {
      NFY_Stats_Clean <- NFY_Pooling_Group_Stats %>%
        dplyr::mutate(ID = as.character(ID))
      Pooling_Group_Export <- dplyr::left_join(
        Pooling_Group_Export,
        NFY_Stats_Clean,
        by = c("donor_station_id" = "ID")
      )
    }
    
    # 10. Export individual station files if requested
    if (export_individual) {
      if (!dir.exists(output_dir)) {
        dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
      }
      
      file_results <- file.path(output_dir, paste0(station_id_str, "_results.csv"))
      file_pg <- file.path(output_dir, paste0(station_id_str, "_pooling_group.csv"))
      file_zdists <- file.path(output_dir, paste0(station_id_str, "_zdists.csv"))
      
      readr::write_csv(Flows, file_results)
      readr::write_csv(Pooling_Group_Export, file_pg)
      readr::write_csv(as.data.frame(as.list(z_scores)), file_zdists)
    }
    
    # Return structured station result
    list(
      station_id = station_id_str,
      success = TRUE,
      error_message = NA_character_,
      design_flows = Flows,
      pooling_group = Pooling_Group_Export,
      non_flood_year_stats = NFY_Pooling_Group_Stats,
      qmed_observed = Gauge_QMED,
      UAF = station_UAF,
      qmed_rural = rural_qmed,
      station_urbext = Station_URBEXT,
      zdists = z_scores,
      distribution = chosen_dist,
      distribution_params = Results[["Distribution Parameters"]],
      weighted_lmoments = Results[["Weighted Lmoment Ratios"]]
    )
    
  }, error = function(e) {
    warning(sprintf("Error processing station %s: %s", station_id_str, e$message), call. = FALSE)
    list(
      station_id = station_id_str,
      success = FALSE,
      error_message = e$message,
      design_flows = NULL,
      pooling_group = NULL,
      non_flood_year_stats = NULL,
      qmed_observed = NA_real_,
      UAF = NA_real_,
      qmed_rural = NA_real_,
      station_urbext = NA_real_,
      zdists = NULL,
      distribution = NA_character_,
      distribution_params = NULL,
      weighted_lmoments = NULL
    )
  })
}
