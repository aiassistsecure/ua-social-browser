import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import browserRouter from "./browser";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(browserRouter);

export default router;
