import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import browserRouter from "./browser";
import mediaRouter from "./media";
import publishRouter from "./publish";
import scheduleRouter from "./schedule";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(browserRouter);
router.use(mediaRouter);
router.use(publishRouter);
router.use(scheduleRouter);

export default router;
