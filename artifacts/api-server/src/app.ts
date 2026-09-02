import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { isAccessGated, requireLocalAccess } from "./lib/local-access";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Under the shell this process can publish through the operator's sessions, so
// it answers no cross-origin caller at all. On the open web surface it holds no
// such capability and the sidebar may be served from another origin.
if (!isAccessGated()) {
  app.use(cors());
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", requireLocalAccess, router);

export default app;
