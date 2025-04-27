#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { Command } from 'commander';
import Papa from 'papaparse';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';

const program = new Command();

program
  .requiredOption('-i, --input <dir>', 'Input directory containing CSV files')
  .requiredOption('-o, --output <dir>', 'Output directory for generated files') // Changed description
  .option('-f, --format <type>', 'Output format type (typescript or i18next)', 'typescript') // Add format option
  .option('-w, --watch', 'Watch input directory for changes') // 監視オプションを追加
  .parse(process.argv);

const options = program.opts();
// Validate format option
if (!['typescript', 'i18next'].includes(options.format)) {
  console.error(`Error: Invalid format "${options.format}". Must be 'typescript' or 'i18next'.`);
  process.exit(1);
}
const inputDir = path.resolve(options.input);
const outputDir = path.resolve(options.output); // Output is now a directory

async function findCsvFiles(dir) {
  let csvFiles = [];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        csvFiles = csvFiles.concat(await findCsvFiles(fullPath));
      } else if (dirent.isFile() && path.extname(dirent.name).toLowerCase() === '.csv') {
        csvFiles.push(fullPath);
      }
    }
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err);
  }
  return csvFiles;
}

async function convertCsvToTs() {
  console.log(`Input directory: ${inputDir}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Output format: ${options.format}`); // Log format

  try {
    await fs.access(inputDir);
  } catch (error) {
    console.error(`Error: Input directory "${inputDir}" not found or not accessible.`);
    process.exit(1);
  }

  // Ensure output directory exists
  try {
    await fs.mkdir(outputDir, { recursive: true });
    console.log(`Ensured output directory exists: ${outputDir}`);
  } catch (err) {
    console.error(`Error creating output directory ${outputDir}:`, err);
    process.exit(1);
  }

  const csvFiles = await findCsvFiles(inputDir);

  if (csvFiles.length === 0) {
    console.warn(`No CSV files found in ${inputDir}. No TypeScript files generated.`);
    return;
  }

  console.log('Found CSV files:');
  csvFiles.forEach(file => console.log(`- ${file}`));

  const translationsByLang = {}; // { ja: { "key": "value" }, en: { ... } }
  const allKeys = new Set(); // To collect all unique keys ("file.key")

  for (const csvFile of csvFiles) {
    try {
      const fileContent = await fs.readFile(csvFile, 'utf8');
      const parsed = Papa.parse(fileContent, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false, // Keep values as strings
      });

      if (parsed.errors.length > 0) {
        console.warn(`\nWarnings parsing ${csvFile}:`);
        parsed.errors.forEach(err => console.warn(`- [${err.type}] ${err.message} (Row: ${err.row})`));
      }

      if (!parsed.meta || !parsed.meta.fields) {
        console.error(`Error: Could not parse header fields from ${csvFile}. Skipping.`);
        continue;
      }

      const languageColumns = parsed.meta.fields.filter(field => field.toLowerCase() !== 'key');

      // Initialize language objects if they don't exist
      languageColumns.forEach(lang => {
        if (!translationsByLang[lang]) {
          translationsByLang[lang] = {};
        }
      });

      const relativePath = path.relative(inputDir, csvFile);
      const baseKey = relativePath
        .replace(/\\/g, '/') // Standardize path separators
        .replace(/\.csv$/i, '')
        .split('/')
        .join('.');

      if (!baseKey && parsed.data.length > 0) {
          console.warn(`Warning: CSV file found directly in input directory: ${csvFile}. Keys will not have a file path prefix.`);
      }

      parsed.data.forEach((row, rowIndex) => {
        const key = row.key;

        if (!key || typeof key !== 'string' || key.trim() === '') {
          console.warn(`Skipping row ${rowIndex + 2} in ${csvFile} due to empty or invalid key.`);
          return;
        }

        const fullKey = baseKey ? `${baseKey}.${key}` : key; // Construct the flat key

        languageColumns.forEach(lang => {
          const value = row[lang];
          // Add translation if value exists and is not empty
          if (value !== undefined && value !== null && value !== '') {
            if (translationsByLang[lang][fullKey]) {
              // Warn about duplicate keys only if the value is different
              if (translationsByLang[lang][fullKey] !== value) {
                 console.warn(`Warning: Duplicate key "${fullKey}" detected for language "${lang}" in ${csvFile} (Row ${rowIndex + 2}). Overwriting previous value "${translationsByLang[lang][fullKey]}" with "${value}".`);
              }
            }
            translationsByLang[lang][fullKey] = value;
          }
        });
        // Add the generated key to the set
        allKeys.add(fullKey);
      });

    } catch (err) {
      console.error(`\nError processing file ${csvFile}:`, err);
    }
  }

  // --- Write TypeScript files for each language ---
  const languages = Object.keys(translationsByLang);
  if (languages.length === 0) {
      console.warn("No language data found in CSV files. No TypeScript files generated.");
      return;
  }

  // --- Generate Output Files Based on Format ---
  if (options.format === 'typescript') {
    await generateTypeScriptFiles(languages, translationsByLang, allKeys, outputDir);
  } else if (options.format === 'i18next') {
    await generateI18nextFiles(languages, translationsByLang, outputDir);
  }

  console.log(`\n${options.format === 'typescript' ? 'TypeScript' : 'JSON'} file generation complete.`); // Dynamic log message
}

// Helper function to convert flat key object to nested object
function nestObject(flatObject) {
  const nested = {};
  for (const key in flatObject) {
    const parts = key.split('.');
    let current = nested;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // Last part, assign the value
        if (current[part] && typeof current[part] === 'object') {
            // Handle potential conflicts if a key is both a node and a leaf
            // e.g., "a.b" and "a.b.c" - prioritize the leaf value? Or throw error?
            // Current behavior: Overwrite node with leaf if conflict occurs later.
            console.warn(`Warning: Key part "${part}" in "${key}" conflicts with an existing node. Overwriting node with value "${flatObject[key]}".`);
        }
        current[part] = flatObject[key];
      } else {
        // Not the last part, ensure a nested object exists
        if (typeof current[part] === 'string') {
             // Handle conflict: trying to create a node where a string value already exists
             console.warn(`Warning: Key part "${part}" in "${key}" conflicts with an existing value. Skipping creation of deeper path.`);
             // Skip this key or handle differently? Current: Skip deeper path for this key.
             current = null; // Stop processing this key
             break;
        }
        if (!current[part]) {
          current[part] = {};
        } else if (typeof current[part] !== 'object') {
            // If it exists but is not an object (e.g., a string from a previous conflicting key like "a.b")
             console.warn(`Warning: Cannot create nested structure for "${key}". Key part "${part}" is already assigned a non-object value.`);
             current = null; // Stop processing this key
             break;
        }
        current = current[part];
      }
    }
  }
  return nested;
}

// --- Output Generation Functions ---

async function generateTypeScriptFiles(languages, translationsByLang, allKeys, outputDir) {
  console.log(`\nGenerating TypeScript files for languages: ${languages.join(', ')}`);

  // --- Write key.ts file ---
  if (allKeys.size > 0) {
    const keyFilePath = path.join(outputDir, 'key.ts');
    const sortedKeysArray = Array.from(allKeys).sort();
    const keyObject = {};
    sortedKeysArray.forEach(key => {
      keyObject[key] = key;
    });
    const keyTsContent = `// Auto-generated by csv-i18n tool. Do not edit manually.\nexport default ${JSON.stringify(keyObject, null, 2)};\n`;
    try {
      await fs.writeFile(keyFilePath, keyTsContent);
      console.log(`- Successfully generated ${keyFilePath}`);
    } catch (err) {
      console.error(`Error writing key file ${keyFilePath}:`, err);
    }
  } else {
      console.warn("No keys found, skipping key.ts generation.");
  }

  // --- Write language .ts files ---
  for (const lang of languages) {
    const flatLangData = translationsByLang[lang];
    const outputFilePath = path.join(outputDir, `${lang}.ts`);
    // Sort keys alphabetically for consistent output
    const sortedKeys = Object.keys(flatLangData).sort();
    const sortedLangData = {};
    sortedKeys.forEach(key => {
        sortedLangData[key] = flatLangData[key];
    });
    // Generate TS content: export default { ... };
    const outputContent = `// Auto-generated by csv-i18n tool. Do not edit manually.\nexport default ${JSON.stringify(sortedLangData, null, 2)};\n`;

    try {
      await fs.writeFile(outputFilePath, outputContent);
      console.log(`- Successfully generated ${outputFilePath}`);
    } catch (err) {
      console.error(`Error writing file ${outputFilePath}:`, err);
    }
  }
}

async function generateI18nextFiles(languages, translationsByLang, outputDir) {
    console.log(`\nGenerating JSON files for languages: ${languages.join(', ')}`);

    // --- Write language .json files ---
    for (const lang of languages) {
        const flatLangData = translationsByLang[lang];
        const outputFilePath = path.join(outputDir, `${lang}.json`);
        const nestedLangData = nestObject(flatLangData);
        // Generate JSON content
        const outputContent = JSON.stringify(nestedLangData, null, 2); // Pretty print JSON

        try {
            await fs.writeFile(outputFilePath, outputContent);
            console.log(`- Successfully generated ${outputFilePath}`);
        } catch (err) {
            console.error(`Error writing file ${outputFilePath}:`, err);
        }
    }
}

// --- Main Conversion Logic ---

// --- Main Execution Logic ---

// Keep the conversion function as is
async function runSingleConversion() {
  console.log('\nStarting conversion...');
  try {
    await convertCsvToTs();
    console.log('Conversion finished successfully.');
  } catch (err) {
    console.error('\nError during conversion:', err);
    process.exit(1); // Exit if conversion fails in single run mode
  }
}

// --- Watch Mode Logic ---
function startWatching() {
  console.log(`\nWatching for file changes in ${inputDir}... (Press Ctrl+C to stop)`);

  let isRunning = false; // Flag to prevent concurrent runs

  try {
    watch(inputDir, { recursive: true }, (eventType, filename) => {
      if (isRunning) {
        console.log(`Skipping event for ${filename || 'unknown file'} as a process is already running.`);
        return;
      }

      // Check if the changed file is a CSV file
      if (filename && filename.toLowerCase().endsWith('.csv')) {
        console.log(`\n[${eventType}] Detected change in: ${filename}. Triggering conversion script...`);
        isRunning = true;

        // Prepare arguments for the child process, removing --watch or -w
        const args = process.argv.slice(2).filter(arg => arg !== '--watch' && arg !== '-w');
        // console.log(`Running command: node ${process.argv[1]} ${args.join(' ')}`); // Keep this commented out unless debugging needed

        const child = spawn(process.execPath, [process.argv[1], ...args], { // Use node executable path
          stdio: 'inherit', // Inherit stdio to show conversion output/errors
        });

        child.on('close', (code) => {
          console.log(`Conversion script finished with code ${code}. Ready for next change.`);
          isRunning = false; // Allow next run
        });

        child.on('error', (err) => {
          console.error('Failed to start conversion script:', err);
          isRunning = false; // Allow next run even on error
        });

      }
      // else if (filename) {
      //    console.log(`Ignoring change in non-CSV file: ${filename}`);
      // } else {
      //    console.log(`Ignoring event with no filename (${eventType})`);
      // }
    });
  } catch (err) {
      console.error(`Error starting watcher on ${inputDir}:`, err);
      console.error("Please ensure the input directory exists and you have permissions.");
      process.exit(1);
  }
}

// --- Entry Point ---
if (options.watch) {
  // Run initial conversion first before starting the watch
  runSingleConversion().then(() => {
      startWatching();
  }).catch(() => {
      console.error("Initial conversion failed. Watch mode will not start.");
      process.exit(1);
  });
} else {
  // Run conversion once and exit if not in watch mode
  runSingleConversion();
}
