-- Rate version 2026.1. Illustrative rates for demonstration, not filed rates.
INSERT INTO rate_versions (id, label, status, notes, created_by, activated_at)
VALUES (1, '2026.1', 'active', 'Initial contractors GL rates', 'system', now());
SELECT setval('rate_versions_id_seq', 1);

INSERT INTO class_rates (version_id, class_code, description, base_rate, min_premium) VALUES
 (1, '91342', 'Carpentry - residential (interior finish)',        9.40, 2500),
 (1, '91560', 'Concrete construction (flatwork, foundations)',    7.30, 3500),
 (1, '91583', 'General contractor - remodel / renovation',       11.50, 5000),
 (1, '92215', 'Electrical work - within buildings',               6.50, 2500),
 (1, '97050', 'HVAC systems - commercial',                         5.10, 2500),
 (1, '98304', 'Painting - exterior / interior',                    8.20, 2500),
 (1, '98482', 'Plumbing - commercial and industrial',              7.50, 3500),
 (1, '98677', 'Roofing - residential',                            22.00, 7500);

INSERT INTO factors (version_id, factor, kind, key, value, label) VALUES
 -- Territory: worst state of operation applies
 (1, 'territory', 'exact', 'AZ', 0.90, 'Arizona'),
 (1, 'territory', 'exact', 'CO', 1.00, 'Colorado'),
 (1, 'territory', 'exact', 'FL', 1.25, 'Florida'),
 (1, 'territory', 'exact', 'GA', 1.00, 'Georgia'),
 (1, 'territory', 'exact', 'NJ', 1.30, 'New Jersey'),
 (1, 'territory', 'exact', 'NV', 1.00, 'Nevada'),
 (1, 'territory', 'exact', 'NY', 1.60, 'New York'),
 (1, 'territory', 'exact', 'SC', 0.95, 'South Carolina'),
 (1, 'territory', 'exact', 'TX', 1.10, 'Texas'),
 (1, 'territory', 'exact', 'WA', 0.95, 'Washington'),
 (1, 'territory', 'exact', 'WY', 0.90, 'Wyoming'),
 -- Increased limits: occurrence/aggregate
 (1, 'ilf', 'exact', '500000/1000000',   0.80, '$500K / $1M'),
 (1, 'ilf', 'exact', '1000000/2000000',  1.00, '$1M / $2M'),
 (1, 'ilf', 'exact', '1000000/3000000',  1.08, '$1M / $3M'),
 (1, 'ilf', 'exact', '2000000/4000000',  1.45, '$2M / $4M'),
 -- Deductible credit
 (1, 'deductible', 'band', '0',     1.00, 'No deductible'),
 (1, 'deductible', 'band', '1000',  0.98, '$1,000+'),
 (1, 'deductible', 'band', '2500',  0.96, '$2,500+'),
 (1, 'deductible', 'band', '5000',  0.93, '$5,000+'),
 (1, 'deductible', 'band', '10000', 0.89, '$10,000+'),
 (1, 'deductible', 'band', '25000', 0.82, '$25,000+'),
 -- Residential work share
 (1, 'residential_pct', 'band', '0',  1.00, '0-25% residential'),
 (1, 'residential_pct', 'band', '26', 1.05, '26-50% residential'),
 (1, 'residential_pct', 'band', '51', 1.12, '51-75% residential'),
 (1, 'residential_pct', 'band', '76', 1.20, '76-100% residential'),
 -- Subcontracted cost share
 (1, 'subcontracted_pct', 'band', '0',  1.00, '0-24% subcontracted'),
 (1, 'subcontracted_pct', 'band', '25', 1.05, '25-49% subcontracted'),
 (1, 'subcontracted_pct', 'band', '50', 1.10, '50-74% subcontracted'),
 (1, 'subcontracted_pct', 'band', '75', 1.15, '75%+ subcontracted'),
 -- No certificates of insurance collected from subcontractors
 (1, 'no_sub_coi', 'exact', 'true', 1.25, 'Subs not required to carry insurance'),
 -- Maximum working height
 (1, 'height_ft', 'band', '0',  1.00, 'Under 15 ft'),
 (1, 'height_ft', 'band', '15', 1.05, '15-29 ft'),
 (1, 'height_ft', 'band', '30', 1.10, '30-49 ft'),
 (1, 'height_ft', 'band', '50', 1.20, '50 ft and over');

INSERT INTO parameters (version_id, name, value, label) VALUES
 (1, 'schedule_mod_min',   0.75, 'Maximum schedule credit (25%)'),
 (1, 'schedule_mod_max',   1.25, 'Maximum schedule debit (25%)'),
 (1, 'experience_mod_min', 0.80, 'Minimum experience mod'),
 (1, 'experience_mod_max', 1.50, 'Maximum experience mod'),
 (1, 'policy_fee',         250,  'Policy fee'),
 -- Surplus lines tax + stamping fee by home state (illustrative)
 (1, 'sl_tax.AZ', 0.0300, 'Arizona surplus lines tax'),
 (1, 'sl_tax.CO', 0.0300, 'Colorado surplus lines tax'),
 (1, 'sl_tax.FL', 0.0500, 'Florida surplus lines tax + service fee'),
 (1, 'sl_tax.GA', 0.0400, 'Georgia surplus lines tax'),
 (1, 'sl_tax.NJ', 0.0500, 'New Jersey surplus lines tax'),
 (1, 'sl_tax.NV', 0.0350, 'Nevada surplus lines tax'),
 (1, 'sl_tax.NY', 0.0375, 'New York surplus lines tax + stamping fee'),
 (1, 'sl_tax.SC', 0.0600, 'South Carolina surplus lines tax'),
 (1, 'sl_tax.TX', 0.0489, 'Texas surplus lines tax + stamping fee'),
 (1, 'sl_tax.WA', 0.0200, 'Washington surplus lines tax'),
 (1, 'sl_tax.WY', 0.0300, 'Wyoming surplus lines tax');
