// Servers register the modules' API error messages at start-up; tests get them here (see vitest.config.ts).
import {loadModuleExceptionLocales} from "../utilities/helpers/exceptionLocales";

loadModuleExceptionLocales();
